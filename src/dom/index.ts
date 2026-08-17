/**
 * The browser adapter layer.
 *
 * A separate subpath so the core stays importable anywhere, including in a
 * server-side render. Nothing in `src/` outside this directory and `src/app/`
 * touches the DOM, so a consumer that bundles the core into an SSR build cannot
 * accidentally evaluate `document` at import time.
 */

export {
	imageDataFromBlob,
	imageDataFromClipboard,
	imageDataFromFile,
	imageDataFromVideo,
} from './image-source.js';
export type { CanvasContextLike, CanvasLike, ImageDecodeDeps, ImageLike } from './image-source.js';

export { isCameraAvailable, listCameras, startCameraScan } from './camera.js';
export type {
	CameraDeps,
	CameraDevice,
	CameraScanHandle,
	CameraScanOptions,
	CameraStatus,
	VideoLike,
} from './camera.js';
