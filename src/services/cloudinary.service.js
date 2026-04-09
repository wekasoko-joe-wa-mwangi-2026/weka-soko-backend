// src/services/cloudinary.service.js
const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a file buffer to Cloudinary.
 *
 * Performance notes:
 * - No eager transformations — these block the upload response while Cloudinary
 *   processes the image server-side before replying. Instead we apply
 *   transformations on-the-fly via URL parameters at display time (faster).
 * - quality: "auto" is still set so Cloudinary optimises on the fly when
 *   the image is served, without slowing down the upload.
 * - resource_type: "image" with format "auto" lets Cloudinary pick the best
 *   format (WebP, AVIF) for the browser automatically.
 *
 * Returns { url, public_id }
 */
function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || "weka-soko/listings",
        resource_type: "image",
        quality: "auto",
        ...options,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, public_id: result.public_id });
      }
    );

    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
}

/**
 * Delete a file from Cloudinary by public_id
 */
async function deleteByPublicId(publicId) {
  return cloudinary.uploader.destroy(publicId);
}

// Keep old name as alias so existing imports don't break
const deleteFile = deleteByPublicId;

module.exports = { uploadBuffer, deleteFile, deleteByPublicId };
