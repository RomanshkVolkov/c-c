use std::io::Cursor;

use image::{imageops::FilterType, DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Webp,
    Jpeg,
    Png,
    Gif,
    Bmp,
    Avif,
}

impl OutputFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Webp => "webp",
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Gif => "gif",
            Self::Bmp => "bmp",
            Self::Avif => "avif",
        }
    }

    pub fn mime(&self) -> &'static str {
        match self {
            Self::Webp => "image/webp",
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Gif => "image/gif",
            Self::Bmp => "image/bmp",
            Self::Avif => "image/avif",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompressOptions {
    pub quality: Option<u8>,
    pub max_width: Option<u32>,
    pub format: OutputFormat,
}

#[derive(Debug, Serialize)]
pub struct CompressResult {
    pub data: Vec<u8>,
    pub format: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub original_bytes: usize,
    pub compressed_bytes: usize,
}

pub fn compress(raw: &[u8], opts: &CompressOptions) -> Result<CompressResult, String> {
    let original_bytes = raw.len();
    let quality = opts.quality.unwrap_or(85).clamp(1, 100);

    let img = image::load_from_memory(raw)
        .map_err(|e| format!("Unsupported format: {e}"))?;

    let img = match opts.max_width {
        Some(max_w) if img.width() > max_w => {
            let ratio = max_w as f64 / img.width() as f64;
            let new_h = (img.height() as f64 * ratio) as u32;
            img.resize_exact(max_w, new_h, FilterType::Lanczos3)
        }
        _ => img,
    };

    let data = encode(&img, &opts.format, quality)?;

    Ok(CompressResult {
        width: img.width(),
        height: img.height(),
        original_bytes,
        compressed_bytes: data.len(),
        format: opts.format.extension().to_string(),
        mime: opts.format.mime().to_string(),
        data,
    })
}

fn encode(img: &DynamicImage, format: &OutputFormat, quality: u8) -> Result<Vec<u8>, String> {
    match format {
        OutputFormat::Webp => {
            let encoder = webp::Encoder::from_image(img)
                .map_err(|e| format!("WebP encoder: {e}"))?;
            Ok(encoder.encode(quality as f32).to_vec())
        }
        OutputFormat::Jpeg => {
            let rgb = img.to_rgb8();
            let mut buf = Vec::new();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
            encoder
                .encode_image(&rgb)
                .map_err(|e| format!("JPEG encoder: {e}"))?;
            Ok(buf)
        }
        OutputFormat::Png => {
            let mut buf = Cursor::new(Vec::new());
            img.write_to(&mut buf, ImageFormat::Png)
                .map_err(|e| format!("PNG encoder: {e}"))?;
            Ok(buf.into_inner())
        }
        OutputFormat::Gif => {
            let mut buf = Cursor::new(Vec::new());
            img.write_to(&mut buf, ImageFormat::Gif)
                .map_err(|e| format!("GIF encoder: {e}"))?;
            Ok(buf.into_inner())
        }
        OutputFormat::Bmp => {
            let mut buf = Cursor::new(Vec::new());
            img.write_to(&mut buf, ImageFormat::Bmp)
                .map_err(|e| format!("BMP encoder: {e}"))?;
            Ok(buf.into_inner())
        }
        OutputFormat::Avif => {
            let mut buf = Cursor::new(Vec::new());
            img.write_to(&mut buf, ImageFormat::Avif)
                .map_err(|e| format!("AVIF encoder: {e}"))?;
            Ok(buf.into_inner())
        }
    }
}
