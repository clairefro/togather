import test from "node:test";
import assert from "node:assert/strict";
import {
  centerAvatarCropOffset,
  getAvatarCropBaseScale,
  normalizeAvatarCropOffset,
} from "./avatar-crop.js";

test("uses image height for the zoom-out baseline so wide images can reach full height", () => {
  assert.equal(getAvatarCropBaseScale(400, 300, 250, 200), 200 / 300);
});

test("keeps the baseline at one-to-one for images that already fit the crop height", () => {
  assert.equal(getAvatarCropBaseScale(100, 100, 250, 200), 200 / 100);
});

test("keeps the full-image zoom level centered when the image is smaller than the crop box", () => {
  const image = { width: 200, height: 100 };
  const centeredOffset = centerAvatarCropOffset(image, 0.5, 250, 200);
  const normalizedOffset = normalizeAvatarCropOffset(centeredOffset, image, 0.5, 250, 200);

  assert.equal(normalizedOffset.x, 75);
  assert.equal(normalizedOffset.y, 75);
});
