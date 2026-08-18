const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing SUPABASE_URL and SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY"
  );
}

const supabase = createClient(url, key, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  }
});

async function memorySearch(query, scope = "global", limit = 10) {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("scope", scope)
    .or(`memory_key.ilike.%${query}%,content.ilike.%${query}%`)
    .order("importance", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return data || [];
}

async function memoryGet(memoryKey, scope = "global") {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("scope", scope)
    .eq("memory_key", memoryKey)
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function memorySave({
  scope = "global",
  memory_key,
  content,
  importance = 5,
  tags = []
}) {
  const { data, error } = await supabase
    .from("memories")
    .upsert(
      {
        scope,
        memory_key,
        content,
        importance,
        tags,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: "scope,memory_key"
      }
    )
    .select()
    .single();

  if (error) throw error;

  return data;
}

async function memoryUpdate(id, patch) {
  const { data, error } = await supabase
    .from("memories")
    .update({
      ...patch,
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;

  return data;
}

async function createTask(task) {
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      task,
      status: "running",
      cycle: 0
    })
    .select()
    .single();

  if (error) throw error;

  return data;
}

async function updateTask(id, patch) {
  const { data, error } = await supabase
    .from("tasks")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;

  return data;
}

async function addTaskEvent(
  taskId,
  actor,
  eventType,
  message,
  cycle = 0
) {
  const { error } = await supabase
    .from("task_events")
    .insert({
      task_id: taskId,
      actor,
      event_type: eventType,
      message,
      cycle
    });

  if (error) throw error;
}

async function addDecision(
  taskId,
  actor,
  decision,
  message = ""
) {
  const { error } = await supabase
    .from("agent_decisions")
    .insert({
      task_id: taskId,
      actor,
      decision,
      message
    });

  if (error) throw error;
}

module.exports = {
  supabase,
  memorySearch,
  memoryGet,
  memorySave,
  memoryUpdate,
  createTask,
  updateTask,
  addTaskEvent,
  addDecision
};