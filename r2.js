import "dotenv/config";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  R2_PUBLIC_URL,
} = process.env;

export function r2Configured() {
  return Boolean(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_URL && (R2_ENDPOINT || R2_ACCOUNT_ID));
}

const client = r2Configured()
  ? new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    })
  : null;

const PUBLIC_URL = (R2_PUBLIC_URL || "").replace(/\/+$/, "");

export async function uploadToR2(buffer, key, contentType) {
  if (!client) {
    throw new Error(
      "Chưa cấu hình đủ biến R2_* trong backend/.env — không thể tải file lên Cloudflare R2"
    );
  }
  await client.send(
    new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, Body: buffer, ContentType: contentType })
  );
  return `${PUBLIC_URL}/${key}`;
}

export async function deleteFromR2(key) {
  if (!client || !key) return;
  try {
    await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  } catch (e) {
    console.error("deleteFromR2 error:", e.message);
  }
}

export function keyFromPublicUrl(url) {
  if (!PUBLIC_URL || !url || !url.startsWith(`${PUBLIC_URL}/`)) return null;
  return decodeURIComponent(url.slice(PUBLIC_URL.length + 1));
}
