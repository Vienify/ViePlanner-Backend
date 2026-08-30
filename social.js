import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "uploads");

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const THREADS_BASE = "https://graph.threads.net/v1.0";
const VIDEO_FORMATS = ["video", "reel", "story_video"];

const {
  FB_PAGE_ID,
  FB_PAGE_ACCESS_TOKEN,
  IG_BUSINESS_ACCOUNT_ID,
  IG_ACCESS_TOKEN,
  THREADS_USER_ID,
  THREADS_ACCESS_TOKEN,
  THREADS_TOKEN_EXPIRES_AT,
  PUBLIC_BASE_URL,
} = process.env;

export const fbConfigured = () => Boolean(FB_PAGE_ID && FB_PAGE_ACCESS_TOKEN);
export const igConfigured = () => Boolean(IG_BUSINESS_ACCOUNT_ID && IG_ACCESS_TOKEN);
export const threadsConfigured = () => Boolean(THREADS_USER_ID && THREADS_ACCESS_TOKEN);

export async function getSocialAccounts() {
  const [facebook, instagram, threads] = await Promise.all([
    (async () => {
      if (!fbConfigured()) return { configured: false };
      try {
        const info = await graphFetch(
          `${GRAPH_BASE}/${FB_PAGE_ID}`,
          { fields: "name,link,picture.type(large){url}", access_token: FB_PAGE_ACCESS_TOKEN },
          "GET"
        );
        return {
          configured: true,
          name: info.name,
          url: info.link || `https://facebook.com/${FB_PAGE_ID}`,
          avatar: info.picture?.data?.url || null,
        };
      } catch (e) {
        return { configured: true, error: e.message };
      }
    })(),
    (async () => {
      if (!igConfigured()) return { configured: false };
      try {
        const info = await graphFetch(
          `${GRAPH_BASE}/${IG_BUSINESS_ACCOUNT_ID}`,
          { fields: "username,name,profile_picture_url", access_token: IG_ACCESS_TOKEN },
          "GET"
        );
        return {
          configured: true,
          name: info.username || info.name,
          url: `https://instagram.com/${info.username}`,
          avatar: info.profile_picture_url || null,
        };
      } catch (e) {
        return { configured: true, error: e.message };
      }
    })(),
    (async () => {
      if (!threadsConfigured()) return { configured: false };
      try {
        const info = await graphFetch(
          `${THREADS_BASE}/me`,
          { fields: "username,threads_profile_picture_url", access_token: THREADS_ACCESS_TOKEN },
          "GET"
        );
        return {
          configured: true,
          name: info.username,
          url: `https://www.threads.com/@${info.username}`,
          avatar: info.threads_profile_picture_url || null,
          tokenExpiresAt: THREADS_TOKEN_EXPIRES_AT || null,
        };
      } catch (e) {
        return { configured: true, error: e.message, tokenExpiresAt: THREADS_TOKEN_EXPIRES_AT || null };
      }
    })(),
  ]);
  return { facebook, instagram, threads };
}

function isVideoFile(filePath) {
  return /\.(mp4|mov|webm)$/i.test(filePath);
}

const THREADS_MANUAL_BREAK = "---";
const THREADS_CHAR_LIMIT = 500;

function cleanCaption(text) {
  return (text || "")
    .split("---")
    .join(" ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function autoSplitByLimit(text, limit) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function splitThreadsContent(text, limit) {
  if (!text) return [];
  const manualParts = text
    .split(THREADS_MANUAL_BREAK)
    .map((p) => p.trim())
    .filter(Boolean);
  const result = [];
  for (const part of manualParts) result.push(...autoSplitByLimit(part, limit));
  return result;
}

function publicUrl(filePath) {
  if (!PUBLIC_BASE_URL) {
    throw new Error(
      "Thiếu PUBLIC_BASE_URL trong backend/.env — Instagram/Threads yêu cầu URL ảnh/video công khai truy cập được từ Internet (deploy server có domain, hoặc dùng ngrok khi test)."
    );
  }
  return `${PUBLIC_BASE_URL}${filePath}`;
}

async function graphFetch(url, params, method = "POST") {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(method === "GET" ? `${url}?${qs}` : url, {
    method,
    headers: method === "GET" ? undefined : { "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : qs,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(json.error?.message || `Graph API lỗi (HTTP ${res.status})`);
  }
  return json;
}

async function uploadFbBinary(endpoint, filePath, fields) {
  const abs = path.join(UPLOAD_DIR, path.basename(filePath));
  const fd = new FormData();
  fd.append("source", new Blob([fs.readFileSync(abs)]), path.basename(abs));
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  fd.append("access_token", FB_PAGE_ACCESS_TOKEN);
  const res = await fetch(`${GRAPH_BASE}/${FB_PAGE_ID}/${endpoint}`, { method: "POST", body: fd });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message || `Lỗi tải lên Facebook (${endpoint})`);
  return json;
}

export async function publishToFacebook(idea, assets) {
  if (!fbConfigured())
    throw new Error("Chưa cấu hình FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN trong backend/.env");

  const caption = cleanCaption(idea.detail_content || idea.content || "");
  const fbAssets = assets.filter((a) => a.kind === "image" && a.platform === "fb");

  if (fbAssets.length === 0) {
    const json = await graphFetch(`${GRAPH_BASE}/${FB_PAGE_ID}/feed`, {
      message: caption,
      access_token: FB_PAGE_ACCESS_TOKEN,
    });
    return { id: json.id };
  }

  const video = fbAssets.find((a) => isVideoFile(a.file_path));
  if (video) {
    const json = await uploadFbBinary("videos", video.file_path, { description: caption });
    return { id: json.id };
  }

  if (fbAssets.length === 1) {
    const json = await uploadFbBinary("photos", fbAssets[0].file_path, {
      caption,
      published: true,
    });
    return { id: json.post_id || json.id };
  }

  const photoIds = [];
  for (const a of fbAssets) {
    const json = await uploadFbBinary("photos", a.file_path, { published: false });
    photoIds.push(json.id);
  }
  const json = await graphFetch(`${GRAPH_BASE}/${FB_PAGE_ID}/feed`, {
    message: caption,
    attached_media: JSON.stringify(photoIds.map((id) => ({ media_fbid: id }))),
    access_token: FB_PAGE_ACCESS_TOKEN,
  });
  return { id: json.id };
}

async function waitForIgContainerReady(creationId) {
  for (let i = 0; i < 20; i++) {
    const json = await graphFetch(
      `${GRAPH_BASE}/${creationId}`,
      { fields: "status_code", access_token: IG_ACCESS_TOKEN },
      "GET"
    );
    if (json.status_code === "FINISHED") return;
    if (json.status_code === "ERROR") throw new Error("Instagram xử lý media thất bại");
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Instagram xử lý media quá lâu, vui lòng thử lại sau");
}

export async function publishToInstagram(idea, assets) {
  if (!igConfigured())
    throw new Error(
      "Chưa cấu hình IG_BUSINESS_ACCOUNT_ID / IG_ACCESS_TOKEN trong backend/.env (yêu cầu tài khoản Instagram Business/Creator liên kết Fanpage)"
    );

  const caption = cleanCaption(idea.detail_content || idea.content || "");
  const igAssets = assets.filter((a) => a.kind === "image" && a.platform === "ig_threads");
  if (igAssets.length === 0)
    throw new Error("Cần ít nhất 1 ảnh/video cho Instagram (không hỗ trợ đăng chỉ chữ)");

  const isStory = idea.post_format === "story_image" || idea.post_format === "story_video";
  const isReel = idea.post_format === "reel";
  const needsWait = VIDEO_FORMATS.includes(idea.post_format);

  let creationId;
  if (igAssets.length > 1 && !isStory) {
    const childIds = [];
    for (const a of igAssets) {
      const video = isVideoFile(a.file_path);
      const params = { is_carousel_item: "true", access_token: IG_ACCESS_TOKEN };
      params[video ? "video_url" : "image_url"] = publicUrl(a.file_path);
      if (video) params.media_type = "VIDEO";
      const json = await graphFetch(`${GRAPH_BASE}/${IG_BUSINESS_ACCOUNT_ID}/media`, params);
      childIds.push(json.id);
    }
    const parent = await graphFetch(`${GRAPH_BASE}/${IG_BUSINESS_ACCOUNT_ID}/media`, {
      media_type: "CAROUSEL",
      caption,
      children: childIds.join(","),
      access_token: IG_ACCESS_TOKEN,
    });
    creationId = parent.id;
  } else {
    const a = igAssets[0];
    const video = isVideoFile(a.file_path);
    const params = { access_token: IG_ACCESS_TOKEN };
    if (isStory) {
      params.media_type = "STORIES";
    } else if (isReel) {
      params.media_type = "REELS";
      params.caption = caption;
    } else if (video) {
      params.media_type = "VIDEO";
      params.caption = caption;
    } else {
      params.caption = caption;
    }
    params[video ? "video_url" : "image_url"] = publicUrl(a.file_path);
    const json = await graphFetch(`${GRAPH_BASE}/${IG_BUSINESS_ACCOUNT_ID}/media`, params);
    creationId = json.id;
  }

  if (needsWait) await waitForIgContainerReady(creationId);

  const published = await graphFetch(`${GRAPH_BASE}/${IG_BUSINESS_ACCOUNT_ID}/media_publish`, {
    creation_id: creationId,
    access_token: IG_ACCESS_TOKEN,
  });
  return { id: published.id };
}

export async function publishToThreads(idea, assets) {
  if (!threadsConfigured())
    throw new Error("Chưa cấu hình THREADS_USER_ID / THREADS_ACCESS_TOKEN trong backend/.env");

  const rawCaption = idea.detail_content || idea.content || "";
  const parts = splitThreadsContent(rawCaption, THREADS_CHAR_LIMIT);
  const mainText = parts[0] || "";
  const replyParts = parts.slice(1);
  const thAssets = assets.filter((a) => a.kind === "image" && a.platform === "ig_threads");

  let creationId;
  if (thAssets.length === 0) {
    const json = await graphFetch(`${THREADS_BASE}/${THREADS_USER_ID}/threads`, {
      media_type: "TEXT",
      text: mainText,
      access_token: THREADS_ACCESS_TOKEN,
    });
    creationId = json.id;
  } else if (thAssets.length === 1) {
    const a = thAssets[0];
    const video = isVideoFile(a.file_path);
    const params = {
      media_type: video ? "VIDEO" : "IMAGE",
      text: mainText,
      access_token: THREADS_ACCESS_TOKEN,
    };
    params[video ? "video_url" : "image_url"] = publicUrl(a.file_path);
    const json = await graphFetch(`${THREADS_BASE}/${THREADS_USER_ID}/threads`, params);
    creationId = json.id;
  } else {
    const childIds = [];
    for (const a of thAssets) {
      const video = isVideoFile(a.file_path);
      const params = {
        media_type: video ? "VIDEO" : "IMAGE",
        is_carousel_item: "true",
        access_token: THREADS_ACCESS_TOKEN,
      };
      params[video ? "video_url" : "image_url"] = publicUrl(a.file_path);
      const json = await graphFetch(`${THREADS_BASE}/${THREADS_USER_ID}/threads`, params);
      childIds.push(json.id);
    }
    const parent = await graphFetch(`${THREADS_BASE}/${THREADS_USER_ID}/threads`, {
      media_type: "CAROUSEL",
      text: mainText,
      children: childIds.join(","),
      access_token: THREADS_ACCESS_TOKEN,
    });
    creationId = parent.id;
  }

  if (thAssets.length > 0) await new Promise((r) => setTimeout(r, 3000));

  const mainPublished = await graphFetch(`${THREADS_BASE}/${THREADS_USER_ID}/threads_publish`, {
    creation_id: creationId,
    access_token: THREADS_ACCESS_TOKEN,
  });

  let previousId = mainPublished.id;
  for (const part of replyParts) {
    const replyCreation = await graphFetch(`${THREADS_BASE}/${THREADS_USER_ID}/threads`, {
      media_type: "TEXT",
      text: part,
      reply_to_id: previousId,
      access_token: THREADS_ACCESS_TOKEN,
    });
    const replyPublished = await graphFetch(`${THREADS_BASE}/${THREADS_USER_ID}/threads_publish`, {
      creation_id: replyCreation.id,
      access_token: THREADS_ACCESS_TOKEN,
    });
    previousId = replyPublished.id;
  }

  return { id: mainPublished.id };
}
