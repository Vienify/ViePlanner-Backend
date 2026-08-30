export async function notify(pool, type, message, ideaId = null, actorName = null) {
  try {
    const [dup] = await pool.query(
      `SELECT id FROM notifications
       WHERE type = ? AND message = ? AND actor_name <=> ? AND idea_id <=> ?
         AND created_at >= (NOW() - INTERVAL 10 SECOND)
       LIMIT 1`,
      [type, message, actorName, ideaId]
    );
    if (dup.length > 0) return;
    await pool.query(
      `INSERT INTO notifications (type, message, idea_id, actor_name) VALUES (?, ?, ?, ?)`,
      [type, message, ideaId, actorName]
    );
  } catch (e) {
    console.error("notify error:", e.message);
  }
}

export function formatDateVNShort(dateStr) {
  const [y, m, d] = String(dateStr).split("-");
  return `${d}/${m}/${y}`;
}
