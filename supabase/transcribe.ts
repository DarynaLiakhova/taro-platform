// Путь Таролога · расшифровка голосовых через Groq (Whisper)
// Supabase → Edge Functions → Deploy a new function → Via Editor → имя: transcribe → вставить этот код → Deploy
// Ключ Groq кладётся в Edge Functions → Secrets под именем GROQ_API_KEY (в код его НЕ вставлять)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // расшифровывать могут только вошедшие на платформу (ученицы и Лена)
  const auth = req.headers.get("Authorization") || "";
  const apikey = req.headers.get("apikey") || "";
  const who = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  if (!who.ok) return json({ error: "auth" }, 401);

  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) return json({ error: "no_key" }, 500);

  let file: File | null = null;
  try { file = (await req.formData()).get("file") as File | null; } catch (_) { /* пусто */ }
  if (!file || !file.size) return json({ error: "no_file" }, 400);
  if (file.size > 24 * 1024 * 1024) return json({ error: "too_big" }, 413);

  const fd = new FormData();
  fd.append("file", file, file.name || "voice.webm");
  fd.append("model", "whisper-large-v3");
  fd.append("language", "ru");
  fd.append("response_format", "json");
  fd.append("temperature", "0");

  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: "groq", status: r.status, message: j?.error?.message || "" }, r.status === 429 ? 429 : 502);
  return json({ text: String(j.text || "").trim() });
});
