const multer = require("multer");
const uploadService = require("../services/upload.service");

const storage = multer.memoryStorage();
const upload = multer({ storage });

// Multer middleware for a single image file under field name "file" by default
const singleImageUpload = upload.single("file");

async function uploadImage(req, res) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Image file is required (field name: file).",
        });
    }

    const folder = req.body.folder || "misc";
    const userId = req.user && req.user.id;

    const { buffer, mimetype } = req.file;
    const result = await uploadService.uploadBuffer({
      buffer,
      mimeType: mimetype,
      folder,
      userId,
    });

    res.json({
      success: true,
      message: "Image uploaded successfully",
      image_url: result.imageUrl,
      key: result.key,
      folder,
    });
  } catch (err) {
    console.error("uploadImage error:", err);
    if (err.message === "S3_NOT_CONFIGURED") {
      return res
        .status(500)
        .json({ success: false, message: "S3 not configured on server" });
    }
    res.status(500).json({ success: false, message: "Failed to upload image" });
  }
}

module.exports = {
  singleImageUpload,
  uploadImage,
};
