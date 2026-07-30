function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getAvatarCropBaseScale(imageWidth, imageHeight, targetWidth, targetHeight) {
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return 1;
  }

  return targetHeight / imageHeight;
}

export function centerAvatarCropOffset(image, scale, targetWidth, targetHeight) {
  return {
    x: (targetWidth - image.width * scale) / 2,
    y: (targetHeight - image.height * scale) / 2,
  };
}

export function normalizeAvatarCropOffset(offset, image, scale, targetWidth, targetHeight) {
  const minX = Math.min(0, targetWidth - image.width * scale);
  const maxX = Math.max(0, targetWidth - image.width * scale);
  const minY = Math.min(0, targetHeight - image.height * scale);
  const maxY = Math.max(0, targetHeight - image.height * scale);

  return {
    x: clampNumber(offset.x, minX, maxX),
    y: clampNumber(offset.y, minY, maxY),
  };
}
