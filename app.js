import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.allowLocalModels = false;
env.useBrowserCache = true;

// Preserve data created before the Rinote AI rebrand.
[
  ["studyspark-history", "rinote-history"],
  ["studyspark-stats", "rinote-stats"],
  ["studyspark-theme", "rinote-theme"],
  ["studyspark-onboarding-seen", "rinote-onboarding-seen"]
].forEach(([oldKey, newKey]) => {
  if (localStorage.getItem(oldKey) !== null && localStorage.getItem(newKey) === null) {
    localStorage.setItem(newKey, localStorage.getItem(oldKey));
  }
  if (localStorage.getItem(oldKey) !== null) {
    localStorage.removeItem(oldKey);
  }
});

const sampleNotes = `Photosynthesis is the process plants use to convert light energy into chemical energy. It takes place mainly in the chloroplasts of plant cells. Chlorophyll, the green pigment inside chloroplasts, absorbs sunlight.

The overall process uses carbon dioxide and water to produce glucose and oxygen. The chemical equation is: 6CO2 + 6H2O + light energy → C6H12O6 + 6O2.

Photosynthesis has two main stages. The light-dependent reactions occur in the thylakoid membranes. They capture sunlight, split water molecules, release oxygen, and produce ATP and NADPH. The Calvin cycle occurs in the stroma and does not directly require light. It uses carbon dioxide, ATP, and NADPH to build glucose.

Photosynthesis is important because it supplies oxygen to Earth's atmosphere and produces the stored chemical energy that supports most food chains. Factors that affect its rate include light intensity, carbon dioxide concentration, water availability, and temperature.`;

const stopWords = new Set("the a an and or but is are was were be been being to of in on for with as at by from it its this that these those into use uses used they their them which who what when where how not no do does can could would should has have had than then also mainly most more".split(" "));
const state = { kit: null, cardIndex: 0, cardFlipped: false, cardMastery: [], quizIndex: 0, quizCorrect: 0, answered: false };
let summarizer = null;
let historyDeleteTarget = null;
let historyPreviewTarget = null;
let onboardingIndex = 0;
const onboardingSteps = [
  {
    number: "01",
    title: "Bring your notes",
    copy: "Paste your class notes or drop in a .txt file. Everything stays private in your browser."
  },
  {
    number: "02",
    title: "Let browser AI help",
    copy: "A real transformer model summarizes your notes locally, while smart tools create topics, flashcards, and a quiz."
  },
  {
    number: "03",
    title: "Learn your way",
    copy: "Edit cards, track mastery, test yourself, and export a polished study kit whenever you're ready."
  }
];

const $ = (id) => document.getElementById(id);
const notesInput = $("notesInput");
const sessionName = $("sessionName");
const fileDrop = $("fileDrop");
const fileInput = $("fileInput");
const toast = (message) => {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 2200);
};

function showInputStatus(type, title, message) {
  const status = $("inputStatus");
  status.classList.remove("hidden", "warning", "info");
  if (type !== "error") status.classList.add(type);
  $("statusIcon").textContent = type === "info" ? "i" : type === "warning" ? "!" : "×";
  $("statusTitle").textContent = title;
  $("statusMessage").textContent = message;
}

function hideInputStatus() {
  $("inputStatus").classList.add("hidden");
}

function showResultNotice(title, message) {
  $("resultNoticeTitle").textContent = title;
  $("resultNoticeMessage").textContent = message;
  $("resultNotice").classList.remove("hidden");
}

function validateNotes(text) {
  const noteWords = words(text);
  const noteSentences = sentences(text);
  const letters = (text.match(/[a-z]/gi) || []).length;
  const meaningfulWords = noteWords.filter(word => !stopWords.has(word));

  if (!text.trim()) return {
    title: "Your notes are empty",
    message: "Paste notes into the text area or import a plain .txt file to begin."
  };
  if (noteWords.length < 30) return {
    title: "These notes are too short",
    message: `We found ${noteWords.length} words. Add at least 30 words so the AI has enough context to build a useful study kit.`
  };
  if (letters / Math.max(text.length, 1) < .45 || meaningfulWords.length < 12) return {
    title: "We couldn't understand this content",
    message: "Use regular sentences with readable words. Lists of symbols, code, tables, or repeated text may not produce a useful study kit."
  };
  if (noteSentences.length < 2) return {
    type: "warning",
    title: "Add a few complete sentences",
    message: "Your notes are long enough, but separating the ideas into sentences will create better summaries, flashcards, and quizzes."
  };
  return null;
}

function renderOnboarding() {
  const step = onboardingSteps[onboardingIndex];
  $("onboardingStep").textContent = `STEP ${onboardingIndex + 1} OF ${onboardingSteps.length}`;
  $("onboardingTitle").textContent = step.title;
  $("onboardingCopy").textContent = step.copy;
  $("onboardingVisual").querySelector(".visual-main").textContent = step.number;
  document.querySelectorAll(".onboarding-dots span").forEach((dot, index) => dot.classList.toggle("active", index === onboardingIndex));
  $("onboardingBack").classList.toggle("hidden", onboardingIndex === 0);
  $("onboardingNext").innerHTML = onboardingIndex === onboardingSteps.length - 1 ? "Start studying <b>✦</b>" : "Next <b>→</b>";
}

function finishOnboarding() {
  $("onboarding").classList.add("hidden");
  localStorage.setItem("rinote-onboarding-seen", "true");
  document.body.style.overflow = "";
}

function showOnboarding() {
  onboardingIndex = 0;
  renderOnboarding();
  $("onboarding").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("onboardingNext").focus();
}

function resetFileDrop() {
  fileDrop.classList.remove("loaded", "error");
  $("fileDropTitle").textContent = "Drop a .txt file here";
  $("fileDropHint").textContent = "or click to browse · maximum 1 MB";
}

async function importTextFile(file) {
  fileDrop.classList.remove("loaded", "error");

  if (!file) return;
  const isTextFile = file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt");
  if (!isTextFile) {
    fileDrop.classList.add("error");
    $("fileDropTitle").textContent = "Unsupported file type";
    $("fileDropHint").textContent = "Please choose a plain .txt file";
    fileInput.value = "";
    showInputStatus("error", "Unsupported file type", "Rinote currently accepts plain-text .txt files only. Try exporting your document as .txt first.");
    return toast("Only .txt files are supported.");
  }
  if (file.size > 1024 * 1024) {
    fileDrop.classList.add("error");
    $("fileDropTitle").textContent = "That file is too large";
    $("fileDropHint").textContent = "Choose a .txt file smaller than 1 MB";
    fileInput.value = "";
    showInputStatus("error", "File is larger than 1 MB", "Choose a smaller file or split your notes into separate study sessions.");
    return toast("The maximum file size is 1 MB.");
  }

  try {
    const text = await file.text();
    if (!text.trim()) throw new Error("empty");
    notesInput.value = text.slice(0, 12000);
    notesInput.dispatchEvent(new Event("input"));
    if (!sessionName.value.trim()) {
      const suggestedName = file.name.replace(/\.txt$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      sessionName.value = suggestedName.replace(/\b\w/g, letter => letter.toUpperCase()).slice(0, 60);
    }
    fileDrop.classList.add("loaded");
    hideInputStatus();
    $("fileDropTitle").textContent = file.name;
    const truncated = text.length > 12000;
    $("fileDropHint").textContent = `${Math.round(file.size / 1024) || 1} KB · ${words(notesInput.value).length} words${truncated ? " · shortened to fit" : ""}`;
    toast(`${file.name} imported successfully`);
  } catch {
    fileDrop.classList.add("error");
    $("fileDropTitle").textContent = "We couldn't read that file";
    $("fileDropHint").textContent = "Try saving it again as a plain .txt file";
    showInputStatus("error", "This file couldn't be processed", "It may be empty, damaged, or use an unsupported text encoding. Try opening it and saving it again as plain text.");
    toast("The selected file could not be read.");
  }
}

function sentences(text) {
  return text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(s => s.trim()).filter(s => s.length > 25) || [];
}

function words(text) {
  return text.toLowerCase().match(/[a-z][a-z-]{2,}/g) || [];
}

function extractTopics(text, limit = 7) {
  const counts = {};
  words(text).filter(w => !stopWords.has(w)).forEach(w => counts[w] = (counts[w] || 0) + 1);
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word]) => word);
}

function summarize(text) {
  const all = sentences(text);
  const topics = extractTopics(text, 12);
  return all.map((sentence, index) => {
    const lower = sentence.toLowerCase();
    const score = topics.reduce((total, topic) => total + (lower.includes(topic) ? 1 : 0), 0);
    return { sentence, score: score + (index === 0 ? 1.5 : 0), index };
  }).sort((a, b) => b.score - a.score).slice(0, Math.min(5, Math.max(3, Math.ceil(all.length * .35))))
    .sort((a, b) => a.index - b.index).map(item => item.sentence);
}

function titleFrom(text) {
  const topics = extractTopics(text, 2);
  return topics.length ? topics.map(w => w[0].toUpperCase() + w.slice(1)).join(" & ") : "New study session";
}

function createFlashcards(text, topics) {
  const all = sentences(text);
  const cards = [];
  all.forEach(sentence => {
    const topic = topics.find(t => sentence.toLowerCase().includes(t));
    if (topic && !cards.some(card => card.topic === topic)) {
      cards.push({
        topic,
        question: `What should you remember about ${topic}?`,
        answer: sentence
      });
    }
  });
  return cards.slice(0, 8);
}

function createQuiz(cards, topics) {
  return cards.slice(0, 5).map((card, index) => {
    const wrong = topics.filter(t => t !== card.topic).slice(index % 3, index % 3 + 3);
    while (wrong.length < 3) wrong.push(["energy", "structure", "process"][wrong.length]);
    const options = [card.topic, ...wrong].sort(() => Math.random() - .5);
    return { question: `Which topic best matches this fact?\n“${card.answer}”`, options, answer: card.topic };
  });
}

function generateKit(text) {
  const topics = extractTopics(text);
  const flashcards = createFlashcards(text, topics);
  if (flashcards.length < 2) {
    const all = sentences(text);
    all.slice(0, 4).forEach((sentence, i) => flashcards.push({
      topic: topics[i] || `concept ${i + 1}`,
      question: `Explain this key idea in your own words.`,
      answer: sentence
    }));
  }
  return {
    title: titleFrom(text),
    summary: summarize(text),
    topics,
    flashcards,
    quiz: createQuiz(flashcards, topics),
    wordCount: words(text).length,
    created: new Date().toISOString()
  };
}

function updateModelProgress(event) {
  if (event.status === "progress" && Number.isFinite(event.progress)) {
    const progress = Math.max(4, Math.round(event.progress));
    $("modelProgress").style.width = `${progress}%`;
    $("loaderPercent").textContent = `${progress}% · downloading model files`;
  } else if (event.status === "ready") {
    $("modelProgress").style.width = "100%";
    $("loaderPercent").textContent = "Model ready";
  } else if (event.status === "initiate") {
    $("loaderPercent").textContent = "Checking browser cache…";
  }
}

async function createAiSummary(text) {
  $("modelLoader").classList.remove("hidden");
  $("loaderTitle").textContent = summarizer ? "AI is reading your notes" : "Loading the AI model";
  $("loaderMessage").textContent = summarizer
    ? "Generating a new summary entirely on your device…"
    : "Downloading a quantized DistilBART transformer. This only happens on the first run.";
  $("modelProgress").style.width = summarizer ? "72%" : "4%";
  $("loaderPercent").textContent = summarizer ? "Running inference…" : "Starting…";

  if (!summarizer) {
    summarizer = await pipeline(
      "summarization",
      "Xenova/distilbart-cnn-6-6",
      { dtype: "q4", device: "wasm", progress_callback: updateModelProgress }
    );
  }

  $("loaderTitle").textContent = "AI is reading your notes";
  $("loaderMessage").textContent = "The transformer is identifying and rewriting the most important ideas…";
  $("modelProgress").style.width = "82%";
  $("loaderPercent").textContent = "Running inference…";

  const cleanText = text.replace(/\s+/g, " ").slice(0, 3500);
  const inputWords = words(cleanText).length;
  const result = await summarizer(cleanText, {
    max_new_tokens: Math.min(150, Math.max(60, Math.round(inputWords * .32))),
    min_new_tokens: Math.min(45, Math.max(20, Math.round(inputWords * .12))),
    no_repeat_ngram_size: 3
  });
  $("modelProgress").style.width = "100%";
  $("loaderPercent").textContent = "Study kit complete";
  return result[0]?.summary_text?.trim() || "";
}

function saveSession(kit) {
  const history = JSON.parse(localStorage.getItem("rinote-history") || "[]");
  history.unshift({
    title: kit.title,
    created: kit.created,
    words: kit.wordCount,
    topics: kit.topics.length,
    kit: {
      ...kit,
      summary: [...kit.summary],
      topics: [...kit.topics],
      flashcards: kit.flashcards.map(card => ({ ...card })),
      quiz: kit.quiz.map(question => ({ ...question, options: [...question.options] }))
    }
  });
  localStorage.setItem("rinote-history", JSON.stringify(history.slice(0, 20)));
}

function renderKit() {
  const kit = state.kit;
  $("emptyState").classList.add("hidden");
  $("results").classList.remove("hidden");
  $("kitTitle").textContent = kit.title;
  $("readingTime").textContent = Math.max(1, Math.ceil(kit.wordCount / 220));
  $("topicCount").textContent = kit.topics.length;
  $("cardCount").textContent = kit.flashcards.length;
  $("summaryList").innerHTML = kit.summary.map(s => `<li>${escapeHtml(s)}</li>`).join("");
  $("topicList").innerHTML = kit.topics.map(t => `<span>${escapeHtml(t)}</span>`).join("");
  state.cardIndex = 0;
  state.cardFlipped = false;
  state.cardMastery = Array(kit.flashcards.length).fill(null);
  state.quizIndex = 0;
  state.quizCorrect = 0;
  renderCard();
  renderQuiz();
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function formatSessionDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

function printableDocument(title, label, content) {
  const date = state.kit?.created ? formatSessionDate(state.kit.created) : formatSessionDate(new Date());
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — ${escapeHtml(label)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { max-width: 820px; margin: 0 auto; padding: 54px 44px; color: #18251f; background: #fff; font-family: Arial, sans-serif; line-height: 1.55; }
    header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; padding-bottom: 22px; border-bottom: 3px solid #d9f986; }
    .brand { color: #174f3b; font-weight: 800; font-size: 14px; letter-spacing: .04em; }
    .brand span { color: #76a43e; }
    .meta { color: #6f7772; font-size: 11px; text-align: right; }
    h1 { margin: 34px 0 4px; font-size: 32px; letter-spacing: -.03em; }
    .subtitle { margin: 0 0 32px; color: #6f7772; font-size: 12px; text-transform: uppercase; letter-spacing: .12em; font-weight: 700; }
    h2 { margin-top: 30px; font-size: 17px; color: #174f3b; }
    ul { padding-left: 20px; }
    li { margin: 10px 0; }
    .topics { display: flex; flex-wrap: wrap; gap: 8px; }
    .topic { padding: 6px 10px; border: 1px solid #dfe2dc; border-radius: 20px; font-size: 11px; }
    .flashcard { break-inside: avoid; margin: 0 0 18px; padding: 22px; border: 1px solid #dfe2dc; border-left: 5px solid #bfe45b; border-radius: 10px; }
    .flashcard small { color: #76a43e; font-weight: 800; letter-spacing: .1em; }
    .flashcard h3 { margin: 8px 0 14px; font-size: 16px; }
    .answer { margin: 0; padding-top: 13px; border-top: 1px solid #e8eae5; color: #465049; }
    footer { margin-top: 45px; padding-top: 15px; border-top: 1px solid #dfe2dc; color: #7a827d; font-size: 10px; text-align: center; }
    @media print {
      body { max-width: none; padding: 18mm 16mm; }
      @page { margin: 12mm; }
    }
  </style>
</head>
<body>
  <header><div class="brand">RINOTE <span>AI</span></div><div class="meta">${date}<br>Private, browser-generated study kit</div></header>
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">${escapeHtml(label)}</p>
  ${content}
  <footer>Generated with Rinote AI · Open this file in a browser and choose Print → Save as PDF</footer>
</body>
</html>`;
}

function downloadPrintable(kind) {
  if (!state.kit) return toast("Generate a study kit before exporting.");
  const kit = state.kit;
  const isSummary = kind === "summary";
  const content = isSummary
    ? `<h2>Key takeaways</h2><ul>${kit.summary.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
       <h2>Important topics</h2><div class="topics">${kit.topics.map(topic => `<span class="topic">${escapeHtml(topic)}</span>`).join("")}</div>`
    : kit.flashcards.map((card, index) => `<article class="flashcard">
        <small>FLASHCARD ${index + 1}</small>
        <h3>${escapeHtml(card.question)}</h3>
        <p class="answer"><strong>Answer:</strong> ${escapeHtml(card.answer)}</p>
      </article>`).join("");

  const documentHtml = printableDocument(kit.title, isSummary ? "AI Summary" : `${kit.flashcards.length} Printable Flashcards`, content);
  const blob = new Blob([documentHtml], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeTitle = kit.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "study-kit";
  link.href = url;
  link.download = `${safeTitle}-${kind}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${isSummary ? "Summary" : "Flashcards"} downloaded—open the file to print or save as PDF.`);
}

function renderCard() {
  const card = state.kit.flashcards[state.cardIndex];
  const status = state.cardMastery[state.cardIndex];
  $("cardSide").textContent = state.cardFlipped ? "ANSWER" : "QUESTION";
  $("flashcardText").textContent = state.cardFlipped ? card.answer : card.question;
  $("cardPosition").textContent = `${state.cardIndex + 1} / ${state.kit.flashcards.length}`;
  $("gotIt").classList.toggle("selected", status === "mastered");
  $("studyAgain").classList.toggle("selected", status === "review");
  renderMastery();
}

function closeCardEditor() {
  $("cardEditor").classList.add("hidden");
}

function openCardEditor() {
  const card = state.kit.flashcards[state.cardIndex];
  $("editorCardNumber").textContent = `Card ${state.cardIndex + 1}`;
  $("editQuestion").value = card.question;
  $("editAnswer").value = card.answer;
  $("cardEditor").classList.remove("hidden");
  $("editQuestion").focus();
}

function refreshStudyContent() {
  state.kit.quiz = createQuiz(state.kit.flashcards, state.kit.topics);
  state.quizIndex = 0;
  state.quizCorrect = 0;
  $("cardCount").textContent = state.kit.flashcards.length;
  renderCard();
  renderQuiz();
}

function deleteCurrentCard() {
  if (state.kit.flashcards.length <= 1) return toast("Keep at least one flashcard in your study kit.");
  const cardNumber = state.cardIndex + 1;
  if (!window.confirm(`Delete flashcard ${cardNumber}? This cannot be undone.`)) return;
  state.kit.flashcards.splice(state.cardIndex, 1);
  state.cardMastery.splice(state.cardIndex, 1);
  if (state.cardIndex >= state.kit.flashcards.length) state.cardIndex = state.kit.flashcards.length - 1;
  state.cardFlipped = false;
  closeCardEditor();
  refreshStudyContent();
  toast(`Flashcard ${cardNumber} deleted.`);
}

function renderMastery() {
  const total = state.cardMastery.length;
  const mastered = state.cardMastery.filter(status => status === "mastered").length;
  const reviewed = state.cardMastery.filter(Boolean).length;
  const percentage = total ? Math.round(mastered / total * 100) : 0;
  $("masteryPercent").textContent = `${percentage}%`;
  $("masteryProgress").style.width = `${percentage}%`;
  $("masteryDetail").textContent = `${mastered} of ${total} cards mastered${reviewed === total && total ? " · round complete" : ""}`;
}

function rateCurrentCard(status) {
  state.cardMastery[state.cardIndex] = status;
  renderCard();
  const total = state.kit.flashcards.length;
  const allRated = state.cardMastery.every(Boolean);
  if (status === "mastered") toast("Nice—you mastered this card!");
  else toast("Added to your review list.");

  setTimeout(() => {
    if (!allRated || state.cardIndex < total - 1) {
      const nextUnrated = state.cardMastery.findIndex((value, index) => !value && index > state.cardIndex);
      state.cardIndex = nextUnrated >= 0 ? nextUnrated : (state.cardIndex + 1) % total;
      state.cardFlipped = false;
      renderCard();
    }
  }, 350);
}

function renderQuiz() {
  const quiz = state.kit.quiz;
  if (!quiz.length) return;
  $("quizFinish").classList.add("hidden");
  $("quizContent").classList.remove("hidden");
  const q = quiz[state.quizIndex];
  $("questionNumber").textContent = `Question ${state.quizIndex + 1} of ${quiz.length}`;
  $("quizScore").textContent = `${state.quizCorrect} correct`;
  $("quizProgress").style.width = `${((state.quizIndex + 1) / quiz.length) * 100}%`;
  $("quizQuestion").textContent = q.question;
  $("quizAnswers").innerHTML = q.options.map(option => `<button class="answer" data-answer="${escapeHtml(option)}">${escapeHtml(option[0].toUpperCase() + option.slice(1))}</button>`).join("");
  state.answered = false;
}

function finishQuiz() {
  const score = Math.round(state.quizCorrect / state.kit.quiz.length * 100);
  $("quizContent").classList.add("hidden");
  $("quizFinish").classList.remove("hidden");
  $("finalScore").textContent = `${score}%`;
  $("scoreMessage").textContent = score >= 80 ? "Excellent work—you’ve got this topic down." : score >= 60 ? "Nice progress. Review the cards and try once more." : "Good first step. Flip through the cards, then come back stronger.";
  const stats = JSON.parse(localStorage.getItem("rinote-stats") || '{"quizzes":0,"scores":[]}');
  stats.quizzes += 1;
  stats.scores.push(score);
  localStorage.setItem("rinote-stats", JSON.stringify(stats));
}

$("sampleButton").addEventListener("click", () => {
  notesInput.value = sampleNotes;
  sessionName.value = "Biology — Photosynthesis";
  notesInput.dispatchEvent(new Event("input"));
  resetFileDrop();
  toast("Sample notes added");
});

notesInput.addEventListener("input", () => {
  $("wordCount").textContent = `${words(notesInput.value).length} words`;
  if (words(notesInput.value).length >= 30) hideInputStatus();
});
$("dismissStatus").addEventListener("click", hideInputStatus);

$("browseButton").addEventListener("click", event => {
  event.stopPropagation();
  fileInput.click();
});
fileDrop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("click", event => event.stopPropagation());
fileInput.addEventListener("change", () => importTextFile(fileInput.files[0]));

["dragenter", "dragover"].forEach(eventName => fileDrop.addEventListener(eventName, event => {
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  fileDrop.classList.add("dragging");
}));

["dragleave", "dragend"].forEach(eventName => fileDrop.addEventListener(eventName, event => {
  event.preventDefault();
  event.stopPropagation();
  fileDrop.classList.remove("dragging");
}));

fileDrop.addEventListener("drop", event => {
  event.preventDefault();
  event.stopPropagation();
  fileDrop.classList.remove("dragging");
  importTextFile(event.dataTransfer.files[0]);
});

document.addEventListener("dragover", event => event.preventDefault());
document.addEventListener("drop", event => event.preventDefault());

$("generateButton").addEventListener("click", async () => {
  const text = notesInput.value.trim();
  const validation = validateNotes(text);
  if (validation) {
    showInputStatus(validation.type || "error", validation.title, validation.message);
    notesInput.focus();
    return toast(validation.title);
  }
  hideInputStatus();
  $("resultNotice").classList.add("hidden");
  const button = $("generateButton");
  const useAi = $("aiMode").checked;
  button.querySelector("span").textContent = useAi ? "Starting AI..." : "Creating...";
  button.disabled = true;
  try {
    state.kit = generateKit(text);
    const customTitle = sessionName.value.trim().replace(/\s+/g, " ");
    if (customTitle) state.kit.title = customTitle;
    if (useAi) {
      const aiSummary = await createAiSummary(text);
      const aiSentences = sentences(aiSummary);
      if (aiSentences.length) state.kit.summary = aiSentences;
      state.kit.aiGenerated = true;
    } else {
      state.kit.aiGenerated = false;
    }
    saveSession(state.kit);
    renderKit();
    $("modelBadge").classList.toggle("hidden", !state.kit.aiGenerated);
    toast(useAi ? "AI study kit created on your device!" : "Fast study kit is ready!");
  } catch (error) {
    console.error("Browser AI failed:", error);
    state.kit = generateKit(text);
    const customTitle = sessionName.value.trim().replace(/\s+/g, " ");
    if (customTitle) state.kit.title = customTitle;
    state.kit.aiGenerated = false;
    saveSession(state.kit);
    renderKit();
    $("modelBadge").classList.add("hidden");
    showResultNotice("Browser AI wasn't available", "We used the built-in local NLP engine instead, so your study kit is still ready and your notes remained private.");
    toast("AI model unavailable—created a fast local study kit instead.");
  } finally {
    $("modelLoader").classList.add("hidden");
    button.querySelector("span").textContent = "Generate study kit";
    button.disabled = false;
  }
});

document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === tab));
  ["summary", "flashcards", "quiz"].forEach(name => $(`${name}Panel`).classList.toggle("hidden", name !== tab.dataset.tab));
}));

$("exportSummary").addEventListener("click", () => downloadPrintable("summary"));
$("exportFlashcards").addEventListener("click", () => downloadPrintable("flashcards"));

$("flashcard").addEventListener("click", () => { state.cardFlipped = !state.cardFlipped; renderCard(); });
$("flashcard").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") $("flashcard").click(); });
$("gotIt").addEventListener("click", () => rateCurrentCard("mastered"));
$("studyAgain").addEventListener("click", () => rateCurrentCard("review"));
$("editCard").addEventListener("click", openCardEditor);
$("deleteCard").addEventListener("click", deleteCurrentCard);
$("cancelEdit").addEventListener("click", closeCardEditor);
$("cancelEditBottom").addEventListener("click", closeCardEditor);
$("cardEditor").addEventListener("submit", event => {
  event.preventDefault();
  const question = $("editQuestion").value.trim();
  const answer = $("editAnswer").value.trim();
  if (!question || !answer) return toast("Both the question and answer are required.");
  const card = state.kit.flashcards[state.cardIndex];
  card.question = question;
  card.answer = answer;
  state.cardMastery[state.cardIndex] = null;
  state.cardFlipped = false;
  closeCardEditor();
  refreshStudyContent();
  toast("Flashcard updated.");
});
$("prevCard").addEventListener("click", () => { state.cardIndex = (state.cardIndex - 1 + state.kit.flashcards.length) % state.kit.flashcards.length; state.cardFlipped = false; closeCardEditor(); renderCard(); });
$("nextCard").addEventListener("click", () => { state.cardIndex = (state.cardIndex + 1) % state.kit.flashcards.length; state.cardFlipped = false; closeCardEditor(); renderCard(); });

$("quizAnswers").addEventListener("click", e => {
  const button = e.target.closest(".answer");
  if (!button || state.answered) return;
  state.answered = true;
  const q = state.kit.quiz[state.quizIndex];
  const correct = button.dataset.answer === q.answer;
  if (correct) state.quizCorrect += 1;
  document.querySelectorAll(".answer").forEach(answer => {
    if (answer.dataset.answer === q.answer) answer.classList.add("correct");
    else if (answer === button) answer.classList.add("wrong");
    answer.disabled = true;
  });
  setTimeout(() => {
    if (state.quizIndex < state.kit.quiz.length - 1) { state.quizIndex += 1; renderQuiz(); }
    else finishQuiz();
  }, 950);
});

$("retryQuiz").addEventListener("click", () => { state.quizIndex = 0; state.quizCorrect = 0; renderQuiz(); });

document.querySelectorAll(".nav-link").forEach(link => link.addEventListener("click", () => {
  document.querySelectorAll(".nav-link").forEach(n => n.classList.toggle("active", n === link));
  document.querySelectorAll("main > .view").forEach(view => {
    view.classList.toggle("hidden", view.id !== `${link.dataset.view}View`);
  });
  if (link.dataset.view === "progress") renderProgress();
  window.scrollTo({ top: 0, behavior: "smooth" });
}));

function renderProgress() {
  const history = JSON.parse(localStorage.getItem("rinote-history") || "[]");
  const stats = JSON.parse(localStorage.getItem("rinote-stats") || '{"quizzes":0,"scores":[]}');
  $("totalSessions").textContent = history.length;
  $("totalQuizzes").textContent = stats.quizzes;
  $("averageScore").textContent = stats.scores.length ? `${Math.round(stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length)}%` : "—";
  $("historyList").innerHTML = history.length ? history.map((item, index) => `
    <div class="history-item">
      <button class="open-history-item" data-history-index="${index}" type="button">
        <h3>${escapeHtml(item.title)}</h3>
        <p>${item.words} words · ${item.topics} topics${item.kit ? " · click to reopen" : ""}</p>
      </button>
      <div class="history-item-meta">
        <span>${escapeHtml(formatSessionDate(item.created))}</span>
        <button class="delete-history-item" data-history-index="${index}" type="button" aria-label="Delete study session">⌫</button>
      </div>
    </div>`).join("") : `<p class="no-history">Your generated study kits will appear here.</p>`;
}

function closeHistoryPreview() {
  $("historyPreview").classList.add("hidden");
  document.body.style.overflow = "";
  historyPreviewTarget = null;
}

function openHistoryPreview(index) {
  const history = JSON.parse(localStorage.getItem("rinote-history") || "[]");
  const item = history[index];
  if (!item) return;
  historyPreviewTarget = index;
  $("historyPreviewTitle").textContent = item.title;
  $("historyPreviewMeta").textContent = `Created ${formatSessionDate(item.created)} · ${item.words} words`;
  $("restoreHistorySession").classList.toggle("hidden", !item.kit);
  $("historyPreviewContent").innerHTML = item.kit ? `
    <h3>AI SUMMARY</h3>
    <ul class="preview-summary">${item.kit.summary.map(point => `<li>${escapeHtml(point)}</li>`).join("")}</ul>
    <h3>KEY TOPICS</h3>
    <div class="preview-topics">${item.kit.topics.map(topic => `<span>${escapeHtml(topic)}</span>`).join("")}</div>
    <h3>${item.kit.flashcards.length} FLASHCARDS</h3>
    <div class="preview-flashcards">${item.kit.flashcards.map(card => `
      <article class="preview-flashcard"><strong>${escapeHtml(card.question)}</strong><p>${escapeHtml(card.answer)}</p></article>
    `).join("")}</div>
  ` : `<div class="legacy-history-message">This session was created before saved-kit previews were added. Its activity record is available, but the generated content cannot be restored.</div>`;
  $("historyPreview").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("closeHistoryPreview").focus();
}

function closeHistoryConfirmation() {
  $("historyConfirm").classList.add("hidden");
  document.body.style.overflow = "";
}

function openHistoryConfirmation(target = null) {
  historyDeleteTarget = target;
  const deletingAll = target === null;
  const history = JSON.parse(localStorage.getItem("rinote-history") || "[]");
  const item = deletingAll ? null : history[target];
  $("historyConfirmTitle").textContent = deletingAll ? "Delete all study history?" : `Delete “${item?.title || "this session"}”?`;
  $("historyConfirmMessage").textContent = deletingAll
    ? "This permanently removes your saved study sessions, completed quiz count, and average scores from this browser. You can’t get this data back."
    : "This permanently removes this study session from your history. Your other sessions and quiz statistics will remain. You can’t undo this action.";
  $("confirmHistoryDelete").textContent = deletingAll ? "Delete permanently" : "Delete session";
  $("historyConfirm").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("cancelHistoryDelete").focus();
}

$("clearHistory").addEventListener("click", () => {
  openHistoryConfirmation();
});
$("historyList").addEventListener("click", event => {
  const button = event.target.closest(".delete-history-item");
  if (button) return openHistoryConfirmation(Number(button.dataset.historyIndex));
  const openButton = event.target.closest(".open-history-item");
  if (openButton) openHistoryPreview(Number(openButton.dataset.historyIndex));
});
$("closeHistoryPreview").addEventListener("click", closeHistoryPreview);
$("closeHistoryPreviewBottom").addEventListener("click", closeHistoryPreview);
$("historyPreview").addEventListener("click", event => {
  if (event.target === $("historyPreview")) closeHistoryPreview();
});
$("restoreHistorySession").addEventListener("click", () => {
  const history = JSON.parse(localStorage.getItem("rinote-history") || "[]");
  const item = history[historyPreviewTarget];
  if (!item?.kit) return;
  state.kit = item.kit;
  sessionName.value = item.kit.title;
  renderKit();
  $("modelBadge").classList.toggle("hidden", !item.kit.aiGenerated);
  closeHistoryPreview();
  document.querySelector('[data-view="workspace"]').click();
  $("outputCard").scrollIntoView({ behavior: "smooth", block: "start" });
  toast("Saved study kit reopened");
});
$("cancelHistoryDelete").addEventListener("click", closeHistoryConfirmation);
$("historyConfirm").addEventListener("click", event => {
  if (event.target === $("historyConfirm")) closeHistoryConfirmation();
});
$("confirmHistoryDelete").addEventListener("click", () => {
  if (historyDeleteTarget === null) {
    [
      "rinote-history",
      "rinote-stats",
      "studyspark-history",
      "studyspark-stats"
    ].forEach(key => localStorage.removeItem(key));
  } else {
    const history = JSON.parse(localStorage.getItem("rinote-history") || "[]");
    history.splice(historyDeleteTarget, 1);
    localStorage.setItem("rinote-history", JSON.stringify(history));
  }
  const deletedAll = historyDeleteTarget === null;
  renderProgress();
  closeHistoryConfirmation();
  toast(deletedAll ? "Study history permanently deleted" : "Study session deleted");
  historyDeleteTarget = null;
});

$("themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem("rinote-theme", document.body.classList.contains("dark") ? "dark" : "light");
});
if (localStorage.getItem("rinote-theme") === "dark") document.body.classList.add("dark");

$("onboardingNext").addEventListener("click", () => {
  if (onboardingIndex < onboardingSteps.length - 1) {
    onboardingIndex += 1;
    renderOnboarding();
  } else {
    finishOnboarding();
  }
});
$("onboardingBack").addEventListener("click", () => {
  onboardingIndex = Math.max(0, onboardingIndex - 1);
  renderOnboarding();
});
$("skipOnboarding").addEventListener("click", finishOnboarding);
document.addEventListener("keydown", event => {
  if (!$("historyPreview").classList.contains("hidden") && event.key === "Escape") {
    closeHistoryPreview();
    return;
  }
  if (!$("historyConfirm").classList.contains("hidden") && event.key === "Escape") {
    closeHistoryConfirmation();
    return;
  }
  if ($("onboarding").classList.contains("hidden")) return;
  if (event.key === "Escape") finishOnboarding();
  if (event.key === "ArrowRight") $("onboardingNext").click();
  if (event.key === "ArrowLeft" && onboardingIndex > 0) $("onboardingBack").click();
});

if (!localStorage.getItem("rinote-onboarding-seen")) {
  showOnboarding();
}

// Deterministic local views used to capture real portfolio screenshots.
// This does not run during normal use.
const demoView = new URLSearchParams(window.location.search).get("demo");
if (demoView) {
  $("onboarding").classList.add("hidden");
  document.body.style.overflow = "";
  notesInput.value = sampleNotes;
  sessionName.value = "Biology — Photosynthesis";
  notesInput.dispatchEvent(new Event("input"));
  resetFileDrop();
  state.kit = generateKit(sampleNotes);
  state.kit.title = sessionName.value;
  state.kit.aiGenerated = true;
  renderKit();
  $("modelBadge").classList.remove("hidden");

  if (demoView === "dark") document.body.classList.add("dark");
  if (demoView === "flashcards" || demoView === "quiz") {
    document.querySelector(`[data-tab="${demoView}"]`).click();
    document.querySelector(".workspace-grid").scrollIntoView({ block: "start" });
  }
  if (demoView === "mobile") {
    document.querySelector(".workspace-grid").scrollIntoView({ block: "start" });
  }
}
