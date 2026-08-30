import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";
import { initDb } from "./db.js";
import {
  fbConfigured,
  igConfigured,
  threadsConfigured,
  getSocialAccounts,
  publishToFacebook,
  publishToInstagram,
  publishToThreads,
} from "./social.js";
import { startScheduler } from "./scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm|quicktime))$/.test(
      file.mimetype
    );
    cb(ok ? null : new Error("Chỉ chấp nhận ảnh (png/jpg/gif/webp/avif) hoặc video (mp4/webm/mov)"), ok);
  },
});

const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const JWT_SECRET = process.env.JWT_SECRET;
const {
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_ACCOUNTS_URL = "https://accounts.zoho.com",
  ZOHO_REDIRECT_URI = "http://localhost:4000/auth/zoho/callback",
  ALLOWED_EMAIL_DOMAIN = "",
} = process.env;

if (!JWT_SECRET) {
  console.error("Thiếu JWT_SECRET trong .env");
  process.exit(1);
}

app.set("trust proxy", 1);

function authCookieOptions(req, maxAge) {
  const secure = req.protocol === "https";
  return { httpOnly: true, sameSite: secure ? "none" : "lax", secure, maxAge };
}

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use("/uploads", express.static(UPLOAD_DIR));

const pool = await initDb();


const zohoConfigured = () =>
  ZOHO_CLIENT_ID && ZOHO_CLIENT_ID !== "YOUR_ZOHO_CLIENT_ID" && ZOHO_CLIENT_SECRET;

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (forwarded ? forwarded.split(",")[0] : req.socket.remoteAddress) || "";
  return ip.replace("::ffff:", "").trim();
}

function parseDevice(userAgent) {
  const ua = userAgent || "";
  let os = "Không rõ hệ điều hành";
  if (/windows/i.test(ua)) os = "Windows";
  else if (/mac os x|macintosh/i.test(ua)) os = "macOS";
  else if (/android/i.test(ua)) os = "Android";
  else if (/iphone|ipad|ipod/i.test(ua)) os = "iOS";
  else if (/linux/i.test(ua)) os = "Linux";

  let browser = "Không rõ trình duyệt";
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/opr\/|opera/i.test(ua)) browser = "Opera";
  else if (/chrome\//i.test(ua)) browser = "Chrome";
  else if (/firefox\//i.test(ua)) browser = "Firefox";
  else if (/safari\//i.test(ua)) browser = "Safari";

  return `${browser} · ${os}`;
}

async function lookupLocation(ip) {
  if (!ip || /^(127\.|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) {
    return "Mạng nội bộ / Localhost";
  }
  try {
    const resp = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country`
    );
    const data = await resp.json();
    if (data.status !== "success") return "Không xác định";
    return [data.city, data.regionName, data.country].filter(Boolean).join(", ") || "Không xác định";
  } catch {
    return "Không xác định";
  }
}

app.get("/auth/zoho", (req, res) => {
  if (!zohoConfigured())
    return res
      .status(500)
      .send("Chưa cấu hình ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET trong backend/.env");
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("zoho_oauth_state", state, authCookieOptions(req, 10 * 60 * 1000));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ZOHO_CLIENT_ID,
    scope: "AaaServer.profile.READ",
    redirect_uri: ZOHO_REDIRECT_URI,
    access_type: "online",
    state,
  });
  res.redirect(`${ZOHO_ACCOUNTS_URL}/oauth/v2/auth?${params}`);
});

// Bước 2: Zoho gọi lại với code → đổi token → lấy thông tin user → tạo phiên
app.get("/auth/zoho/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${FRONTEND_URL}/login?error=${encodeURIComponent(error)}`);
    if (!code || !state || state !== req.cookies.zoho_oauth_state)
      return res.redirect(`${FRONTEND_URL}/login?error=invalid_state`);
    res.clearCookie("zoho_oauth_state");

    const tokenRes = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        redirect_uri: ZOHO_REDIRECT_URI,
        code: String(code),
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token)
      return res.redirect(
        `${FRONTEND_URL}/login?error=${encodeURIComponent(tokenData.error || "token_failed")}`
      );

    const infoRes = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/user/info`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const info = await infoRes.json();
    if (!info.ZUID)
      return res.redirect(`${FRONTEND_URL}/login?error=userinfo_failed`);

    const zohoId = String(info.ZUID);
    const email = info.Email || "";
    const displayName = info.Display_Name || `${info.First_Name || ""} ${info.Last_Name || ""}`.trim();

    if (
      ALLOWED_EMAIL_DOMAIN &&
      !email.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN.toLowerCase()}`)
    ) {
      return res.redirect(`${FRONTEND_URL}/login?error=domain_not_allowed`);
    }

    const clientIp = getClientIp(req);
    const device = parseDevice(req.headers["user-agent"]);
    const location = await lookupLocation(clientIp);

    await pool.query(
      `INSERT INTO users (zoho_id, email, display_name, last_login_ip, last_login_device, last_login_location)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE email = VALUES(email), display_name = VALUES(display_name),
         last_login = CURRENT_TIMESTAMP, last_login_ip = VALUES(last_login_ip),
         last_login_device = VALUES(last_login_device), last_login_location = VALUES(last_login_location)`,
      [zohoId, email, displayName, clientIp, device, location]
    );
    const [[user]] = await pool.query(`SELECT id, email, display_name FROM users WHERE zoho_id = ?`, [zohoId]);

    const token = jwt.sign(
      { uid: user.id, email: user.email, name: user.display_name },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    // Frontend/backend khác domain nhau => KHÔNG dùng cookie (bị trình duyệt chặn
    // cookie cross-site trên nhiều máy/trình duyệt). Gửi token qua query string,
    // frontend sẽ lưu vào localStorage rồi xoá khỏi URL.
    res.redirect(`${FRONTEND_URL}/?token=${encodeURIComponent(token)}`);
  } catch (e) {
    console.error("Zoho callback error:", e);
    res.redirect(`${FRONTEND_URL}/login?error=server_error`);
  }
});

app.post("/auth/logout", (_req, res) => {
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Chưa đăng nhập" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Phiên đăng nhập hết hạn" });
  }
}

app.use("/api", requireAuth);

app.get("/api/me", async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT zoho_id, created_at, last_login, last_login_ip, last_login_device, last_login_location FROM users WHERE id = ?`,
      [req.user.uid]
    );
    res.json({
      id: req.user.uid,
      email: req.user.email,
      name: req.user.name,
      zoho_id: row?.zoho_id || null,
      created_at: row?.created_at || null,
      last_login: row?.last_login || null,
      last_login_ip: row?.last_login_ip || null,
      last_login_device: row?.last_login_device || null,
      last_login_location: row?.last_login_location || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


const IDEA_FIELDS = [
  "post_date",
  "category",
  "post_format",
  "content",
  "detail_content",
  "asset_note",
  "time_fb",
  "time_ig",
  "time_threads",
  "status",
];

function normalizeIdea(body) {
  const out = {};
  for (const f of IDEA_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

async function attachAssets(ideas) {
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

function formatIdea(row) {
  return {
    ...row,
    post_date:
      row.post_date instanceof Date
        ? row.post_date.toISOString().slice(0, 10)
        : String(row.post_date).slice(0, 10),
  };
}

app.get("/api/categories", async (_req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id, name FROM categories ORDER BY sort_order, id`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ideas", async (req, res) => {
  try {
    const { month } = req.query;
    let rows;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      [rows] = await pool.query(
        `SELECT * FROM ideas WHERE DATE_FORMAT(post_date, '%Y-%m') = ? ORDER BY post_date, id`,
        [month]
      );
    } else {
      [rows] = await pool.query(`SELECT * FROM ideas ORDER BY post_date, id`);
    }
    const withAssets = await attachAssets(rows.map(formatIdea));
    res.json(withAssets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ideas/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM ideas WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Không tìm thấy" });
    const [idea] = await attachAssets(rows.map(formatIdea));
    res.json(idea);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ideas", async (req, res) => {
  try {
    const data = normalizeIdea(req.body);
    if (!data.post_date) return res.status(400).json({ error: "Thiếu ngày đăng (post_date)" });
    const [result] = await pool.query(`INSERT INTO ideas SET ?`, [data]);
    const [rows] = await pool.query(`SELECT * FROM ideas WHERE id = ?`, [result.insertId]);
    const [idea] = await attachAssets(rows.map(formatIdea));
    res.status(201).json(idea);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/ideas/:id", async (req, res) => {
  try {
    const data = normalizeIdea(req.body);
    if (Object.keys(data).length === 0)
      return res.status(400).json({ error: "Không có dữ liệu cập nhật" });
    await pool.query(`UPDATE ideas SET ? WHERE id = ?`, [data, req.params.id]);
    const [rows] = await pool.query(`SELECT * FROM ideas WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Không tìm thấy" });
    const [idea] = await attachAssets(rows.map(formatIdea));
    res.json(idea);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/ideas/:id", async (req, res) => {
  try {
    const [assets] = await pool.query(`SELECT file_path FROM assets WHERE idea_id = ?`, [
      req.params.id,
    ]);
    await pool.query(`DELETE FROM ideas WHERE id = ?`, [req.params.id]);
    for (const a of assets) {
      const p = path.join(UPLOAD_DIR, path.basename(a.file_path));
      fs.promises.unlink(p).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ideas/:id/assets", upload.array("files", 10), async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id FROM ideas WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Không tìm thấy ý tưởng" });
    const kind = req.body.kind === "demo" ? "demo" : "image";
    const platform =
      kind === "demo" ? "general" : req.body.platform === "ig_threads" ? "ig_threads" : "fb";
    const inserted = [];
    for (const f of req.files || []) {
      const filePath = `/uploads/${f.filename}`;
      const [r] = await pool.query(
        `INSERT INTO assets (idea_id, file_path, original_name, kind, platform) VALUES (?, ?, ?, ?, ?)`,
        [req.params.id, filePath, f.originalname, kind, platform]
      );
      inserted.push({
        id: r.insertId,
        idea_id: Number(req.params.id),
        file_path: filePath,
        original_name: f.originalname,
        kind,
        platform,
      });
    }
    res.status(201).json(inserted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/assets/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT file_path FROM assets WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Không tìm thấy" });
    await pool.query(`DELETE FROM assets WHERE id = ?`, [req.params.id]);
    const p = path.join(UPLOAD_DIR, path.basename(rows[0].file_path));
    fs.promises.unlink(p).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get("/api/social/status", (_req, res) => {
  res.json({
    facebook: fbConfigured(),
    instagram: igConfigured(),
    threads: threadsConfigured(),
  });
});

app.get("/api/social/accounts", async (_req, res) => {
  try {
    const accounts = await getSocialAccounts();
    res.json(accounts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PUBLISHERS = {
  facebook: { fn: publishToFacebook, col: "fb_post_id" },
  instagram: { fn: publishToInstagram, col: "ig_post_id" },
  threads: { fn: publishToThreads, col: "threads_post_id" },
};

app.post("/api/ideas/:id/publish/:platform", async (req, res) => {
  const publisher = PUBLISHERS[req.params.platform];
  if (!publisher) return res.status(400).json({ error: "Nền tảng không hợp lệ" });
  try {
    const [rows] = await pool.query(`SELECT * FROM ideas WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Không tìm thấy ý tưởng" });
    const [idea] = await attachAssets(rows.map(formatIdea));

    const result = await publisher.fn(idea, idea.assets);

    await pool.query(`UPDATE ideas SET ${publisher.col} = ?, status = 'posted' WHERE id = ?`, [
      result.id,
      req.params.id,
    ]);
    const [updatedRows] = await pool.query(`SELECT * FROM ideas WHERE id = ?`, [req.params.id]);
    const [updated] = await attachAssets(updatedRows.map(formatIdea));
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

startScheduler(pool);

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`Backend chạy tại http://localhost:${PORT}`);
});
