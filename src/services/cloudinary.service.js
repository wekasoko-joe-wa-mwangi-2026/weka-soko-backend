// src/services/cloudinary.service.js
const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a file buffer to Cloudinary
 * Returns { url, public_id }
 */
function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || "weka-soko/listings",
        resource_type: "image",
        transformation: [
          { width: 1200, height: 900, crop: "limit", quality: "auto:good" },
          { fetch_format: "auto" },
        ],
        ...options,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, public_id: result.public_id });
      }
    );

    // Pipe buffer into the upload stream
    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
}

/**
 * Delete a file from Cloudinary by public_id
 */
async function deleteFile(publicId) {
  return cloudinary.uploader.destroy(publicId);
}

module.exports = { uploadBuffer, deleteFile };
