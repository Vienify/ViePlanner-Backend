import { fbConfigured, igConfigured, publishToFacebook, publishToInstagram } from "./social.js";

const CHECK_INTERVAL_MS = 60 * 1000;

const PLATFORMS = [
  { name: "Facebook", timeCol: "time_fb", idCol: "fb_post_id", configured: fbConfigured, publish: publishToFacebook },
  { name: "Instagram", timeCol: "time_ig", idCol: "ig_post_id", configured: igConfigured, publish: publishToInstagram },
];

async function attachAssets(pool, ideas) {
  if (ideas.length === 0) return ideas;
  const ids = ideas.map((i) => i.id);
  const [assets] = await pool.query(
    `SELECT id, idea_id, file_path, original_name, kind, platform FROM assets WHERE idea_id IN (?) ORDER BY id`,
    [ids]
  );
  const byIdea = new Map();
  for (const a of assets) {
    if (!byIdea.has(a.idea_id)) byIdea.set(a.idea_id, []);
    byIdea.get(a.idea_id).push(a);
  }
  return ideas.map((i) => ({ ...i, assets: byIdea.get(i.id) || [] }));
}

async function checkAndPublishPlatform(pool, platform) {
  if (!platform.configured()) return;

  let dueIdeas;
  try {
    [dueIdeas] = await pool.query(
      `SELECT * FROM ideas
       WHERE status IN ('scheduled', 'posted') AND ${platform.idCol} IS NULL AND ${platform.timeCol} <> ''
         AND TIMESTAMP(post_date, ${platform.timeCol}) <= NOW()`
    );
  } catch (e) {
    console.error(`Lỗi kiểm tra lịch đăng ${platform.name} tự động:`, e.message);
    return;
  }
  if (dueIdeas.length === 0) return;

  const withAssets = await attachAssets(pool, dueIdeas);
  for (const idea of withAssets) {
    try {
      const result = await platform.publish(idea, idea.assets);
      await pool.query(`UPDATE ideas SET ${platform.idCol} = ?, status = 'posted' WHERE id = ?`, [
        result.id,
        idea.id,
      ]);
      console.log(`Đã tự động đăng ${platform.name} cho ý tưởng #${idea.id} (giờ đặt: ${idea[platform.timeCol]})`);
    } catch (e) {
      console.error(`Tự động đăng ${platform.name} thất bại cho ý tưởng #${idea.id}:`, e.message);
    }
  }
}

async function checkAndPublish(pool) {
  for (const platform of PLATFORMS) {
    await checkAndPublishPlatform(pool, platform);
  }
}

export function startScheduler(pool) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await checkAndPublish(pool);
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
  console.log("Đã bật lịch đăng tự động Facebook/Instagram (kiểm tra mỗi 1 phút)");
}
