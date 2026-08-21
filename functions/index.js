/**
 * Nicolaus English Platform — Cloud Functions
 *
 * Tudo que precisa do Admin SDK (criar/apagar conta no Firebase Auth,
 * atribuir custom claims de papel professor/aluno) ou de um segredo
 * (a chave da API da Anthropic) mora aqui — nunca no front-end.
 *
 * Deploy: firebase deploy --only functions
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const LEVELS_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"];
const LEVEL_NAMES = {
  A1: "Iniciante", A2: "Básico", B1: "Intermediário",
  B2: "Intermediário Superior", C1: "Avançado", C2: "Proficiente",
};

function assertProfessor(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "É preciso estar autenticado.");
  }
  if (request.auth.token.role !== "professor") {
    throw new HttpsError("permission-denied", "Somente o professor pode fazer isso.");
  }
}

/* ============================================================
 * bootstrapProfessor
 * Chamada uma única vez, logo após o PRÓPRIO usuário se
 * autocadastrar no Firebase Auth pela tela inicial. Só funciona
 * se ainda não existir professor configurado (config/meta).
 * ============================================================ */
exports.bootstrapProfessor = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "É preciso estar autenticado.");
  }
  const metaRef = db.collection("config").doc("meta");
  const metaSnap = await metaRef.get();
  if (metaSnap.exists && metaSnap.data().setupComplete) {
    throw new HttpsError("failed-precondition", "O acesso do professor já foi configurado anteriormente.");
  }

  await admin.auth().setCustomUserClaims(request.auth.uid, { role: "professor" });
  await metaRef.set({
    setupComplete: true,
    professorUid: request.auth.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

/* ============================================================
 * createStudent
 * Só o professor pode chamar. Cria a conta no Firebase Auth
 * (sem afetar a sessão logada do professor, diferente de criar
 * pelo SDK do cliente) e o documento correspondente no Firestore.
 * ============================================================ */
exports.createStudent = onCall(async (request) => {
  assertProfessor(request);
  const { name, email, password } = request.data || {};

  if (!name || typeof name !== "string" || !name.trim()) {
    throw new HttpsError("invalid-argument", "Informe o nome do aluno.");
  }
  if (!password || password.length < 4) {
    throw new HttpsError("invalid-argument", "A senha inicial precisa ter pelo menos 4 caracteres.");
  }

  const slug = name.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const finalEmail = (email && email.trim()) || `${slug}-${Date.now().toString(36).slice(-5)}@aluno.nicolaus.app`;

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: finalEmail,
      password,
      displayName: name.trim(),
    });
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "Já existe uma conta com esse e-mail.");
    }
    throw new HttpsError("internal", "Não foi possível criar a conta: " + err.message);
  }

  await admin.auth().setCustomUserClaims(userRecord.uid, { role: "student" });

  await db.collection("students").doc(userRecord.uid).set({
    name: name.trim(),
    email: finalEmail,
    hasCustomEmail: !!(email && email.trim()),
    phone: "",
    level: "",
    status: "ativo",
    testHistory: [],
    mustChangePassword: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { uid: userRecord.uid, email: finalEmail };
});

/* ============================================================
 * resetStudentPassword
 * Só o professor. Define uma nova senha temporária para um
 * aluno (ex: aluno esqueceu a senha) e força troca no próximo
 * login.
 * ============================================================ */
exports.resetStudentPassword = onCall(async (request) => {
  assertProfessor(request);
  const { studentUid, newPassword } = request.data || {};
  if (!studentUid || !newPassword || newPassword.length < 4) {
    throw new HttpsError("invalid-argument", "Informe o aluno e uma senha com pelo menos 4 caracteres.");
  }
  await admin.auth().updateUser(studentUid, { password: newPassword });
  await db.collection("students").doc(studentUid).update({ mustChangePassword: true });
  return { ok: true };
});

/* ============================================================
 * deleteStudent
 * Só o professor. Remove a conta do Firebase Auth e os
 * documentos do aluno (perfil, aulas, pagamentos, atividades).
 * ============================================================ */
exports.deleteStudent = onCall(async (request) => {
  assertProfessor(request);
  const { studentUid } = request.data || {};
  if (!studentUid) throw new HttpsError("invalid-argument", "Informe o aluno.");

  await admin.auth().deleteUser(studentUid).catch(() => null); // já pode ter sido removido no Auth

  const batch = db.batch();
  batch.delete(db.collection("students").doc(studentUid));
  batch.delete(db.collection("directory").doc(studentUid));

  for (const col of ["classes", "payments", "assignments"]) {
    const snap = await db.collection(col).where("studentId", "==", studentUid).get();
    snap.forEach((doc) => batch.delete(doc.ref));
  }

  await batch.commit();
  return { ok: true };
});

/* ============================================================
 * syncStudentDirectory (trigger)
 * Mantém directory/{uid} (só o campo "name", de leitura pública)
 * sincronizado sempre que students/{uid} é criado, editado ou
 * removido — usado apenas para a tela "quem é você?" do login.
 * ============================================================ */
exports.syncStudentDirectory = onDocumentWritten("students/{studentId}", async (event) => {
  const studentId = event.params.studentId;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;

  if (!after) {
    await db.collection("directory").doc(studentId).delete().catch(() => null);
    return;
  }
  await db.collection("directory").doc(studentId).set({
    name: after.name || "",
    level: after.level || "",
    email: after.email || "",
  });
});

/* ============================================================
 * gradeWriting
 * Avalia uma redação do aluno usando a API da Anthropic.
 * A chave fica só aqui no servidor (Secret Manager), nunca no
 * front-end. Requer usuário autenticado (professor ou aluno).
 * ============================================================ */
exports.gradeWriting = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "É preciso estar autenticado.");
  }
  const { lessonLevel, lessonPrompt, text } = request.data || {};
  if (!lessonPrompt || !text || !text.trim()) {
    throw new HttpsError("invalid-argument", "Faltam dados para avaliar a redação.");
  }
  if (text.trim().length > 6000) {
    throw new HttpsError("invalid-argument", "Texto muito longo para avaliação.");
  }

  const prompt = `Você é um professor de inglês avaliando a redação de um aluno em uma plataforma de ensino particular.

Tema proposto (nível alvo ${lessonLevel} - ${LEVEL_NAMES[lessonLevel] || ""}): "${lessonPrompt}"

Texto do aluno:
"""
${text}
"""

Avalie o texto considerando gramática, vocabulário, coesão e adequação ao nível proposto. Responda APENAS com um objeto JSON válido, sem markdown e sem texto antes ou depois, exatamente neste formato:
{"level":"A1|A2|B1|B2|C1|C2","score":0-100,"feedback":"comentário construtivo em português, 2 a 3 frases, destacando pontos fortes e o que melhorar"}`;

  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY.value(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (err) {
    throw new HttpsError("unavailable", "Não foi possível contatar o serviço de avaliação agora.");
  }

  if (!response.ok) {
    throw new HttpsError("internal", "O serviço de avaliação retornou um erro.");
  }

  const data = await response.json();
  const raw = (data.content || []).map((b) => b.text || "").join("").trim();
  const clean = raw.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    throw new HttpsError("internal", "Resposta inesperada do avaliador. Tente novamente.");
  }

  return {
    level: LEVELS_ORDER.includes(parsed.level) ? parsed.level : lessonLevel,
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    feedback: String(parsed.feedback || "").slice(0, 1000),
  };
});
