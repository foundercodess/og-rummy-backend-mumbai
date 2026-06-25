const express = require('express');
const { requireAuth } = require('../middleware/auth');
const uploadController = require('../controllers/upload.controller');

const router = express.Router();
//noone
// Common image upload endpoint:
// - Auth required
// - multipart/form-data with field "file"
// - optional field "folder" to choose S3 folder (e.g. "kyc", "dispute", "avatar")
router.post('/image', uploadController.singleImageUpload, uploadController.uploadImage);

module.exports = router;



