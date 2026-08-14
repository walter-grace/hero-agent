// The Hero/Universe game: teacher/student learning that compounds on-chain.
//
// The HERO is the student: a small, fast, cheap model doing real work with tools. The UNIVERSE is
// the teacher: a frontier model that holds everything, watches the student's trace, and distills
// ONE durable lesson from each attempt worth learning from. Lessons are minted to the agent's
// on-chain memory as `lesson::` entries, and every future session injects them into the student's
// system prompt. The small model stays small; the WALLET gets smarter.
//
// This is the memory thesis closing its loop: the knowledge doesn't live in any model's weights,
// it lives in memory you own, teachable by any frontier, usable by any student.
import { readMemory, writeMemory, BASE } from "./api.mjs";

export const UNIVERSE_MODEL = process.env.HERO_UNIVERSE_MODEL || "auto"; // the teacher's brain

const TEACHER_SYS = `You are the Universe: the teacher that holds everything the frontier knows. A student agent (a small model) just attempted a task in a user's terminal, with tools. Distill ONE durable lesson that would make the student better at FUTURE tasks.
Rules:
- Generalize. A lesson is a transferable rule, never task-specific trivia.
- Imperative voice, under 50 words, starting with "When".
- Prefer lessons about method: tool choice, verification, avoiding waste, honesty about uncertainty.
- If the attempt was already close to optimal and no durable lesson exists, reply with exactly: NO_LESSON`;

// Ask the Universe to review one student turn. Returns the lesson string or null.
export async function universeReview({ key, task, trace, answer, model = UNIVERSE_MODEL, signal }) {
  const toolLines = (trace || []).map((t) => `- ${t.name}(${JSON.stringify(t.args).slice(0, 140)})${t.note ? ` → ${t.note}` : ""}`).join("\n") || "(no tools used)";
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, signal,
    body: JSON.stringify({ model, max_tokens: 200, messages: [
      { role: "system", content: TEACHER_SYS },
      { role: "user", content: `TASK: ${task}\n\nTOOL TRACE:\n${toolLines}\n\nSTUDENT'S FINAL ANSWER:\n${String(answer || "").slice(0, 1500)}` },
    ] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `universe review failed (${r.status})`);
  const text = (d.choices?.[0]?.message?.content || "").trim();
  const cost = Number(d.choices?.[0]?.message?.x_hero?.charged_hero || d.x_hero?.charged_hero || 0);
  if (!text || text.includes("NO_LESSON")) return { lesson: null, cost };
  return { lesson: text.replace(/^lesson::\s*/i, "").trim(), cost };
}

// Mint a lesson to the agent's on-chain memory. One checkpoint, standard entry format.
export async function mintLesson(agentId, lesson) {
  return writeMemory(agentId, [{ role: "agent", text: `lesson:: ${lesson}` }]);
}

// Pull the agent's earned lessons (ROOT + tail), newest last, deduped, capped for the prompt.
export async function recallLessons(agentId, { max = 12 } = {}) {
  try {
    const entries = await readMemory(agentId, { limit: 80 }); // plain array; ROOT text included as entries
    const texts = [];
    for (const e of entries || []) {
      for (const m of String(e?.text || "").matchAll(/lesson::\s*([^\n]+)/g)) texts.push(m[1].trim());
    }
    return [...new Set(texts)].slice(-max);
  } catch { return []; }
}

// Format lessons for injection into the student's system prompt.
export function lessonsBlock(lessons) {
  if (!lessons?.length) return "";
  return `\n\n=== LESSONS you have earned from past attempts (follow them) ===\n${lessons.map((l) => `- ${l}`).join("\n")}`;
}
