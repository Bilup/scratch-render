const twgl = require('twgl.js');

const Skin = require('./Skin');

class BitmapSkin extends Skin {
    /**
     * Create a new Bitmap Skin.
     * @extends Skin
     * @param {!int} id - The ID for this Skin.
     * @param {!RenderWebGL} renderer - The renderer which will use this skin.
     */
    constructor (id, renderer) {
        super(id, renderer);

        /** @type {!int} */
        this._costumeResolution = 1;

        /** @type {Array<int>} */
        this._textureSize = [0, 0];
    }

    /**
     * Dispose of this object. Do not use it after calling this method.
     */
    dispose () {
        if (this._texture) {
            this._renderer.gl.deleteTexture(this._texture);
            this._texture = null;
        }
        super.dispose();
    }

    /**
     * @return {Array<number>} the "native" size, in texels, of this skin.
     */
    get size () {
        return [this._textureSize[0] / this._costumeResolution, this._textureSize[1] / this._costumeResolution];
    }

    /**
     * @param {Array<number>} scale - The scaling factors to be used.
     * @return {WebGLTexture} The GL texture representation of this skin when drawing at the given scale.
     */
    // eslint-disable-next-line no-unused-vars
    getTexture (scale) {
        return this._texture || super.getTexture();
    }

    /**
     * Set the contents of this skin to a snapshot of the provided bitmap data.
     * @param {ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bitmapData - new contents for this skin.
     * @param {int} [costumeResolution=1] - The resolution to use for this bitmap.
     * @param {Array<number>} [rotationCenter] - Optional rotation center for the bitmap. If not supplied, it will be
     * calculated from the bounding box
     * @fires Skin.event:WasAltered
     */
    setBitmap (bitmapData, costumeResolution, rotationCenter) {
        if (!bitmapData.width || !bitmapData.height) {
            super.setEmptyImageData();
            return;
        }
        const gl = this._renderer.gl;

        // Renderer-side quality ceiling. A bitmap costume larger than the
        // renderer's maximum texture dimension is uploaded at reduced texel
        // density instead of at full resolution. This is the only ceiling a
        // bitmap has ever had: SVGSkin clamps itself to the same value (see
        // SVGSkin._materializeSVG) but bitmaps used to be uploaded at whatever
        // size the project contained, so a single imported photo could cost
        // tens of megabytes of GPU memory and again as much in the silhouette.
        // Geometry is untouched -- see _clampBitmapSize -- so this only trades
        // sharpness for memory, and only above the ceiling.
        const clamped = BitmapSkin._clampBitmapSize(bitmapData, this._renderer.maxTextureDimension);

        // TW: We want to use <canvas> as-is because reading ImageData wastes memory.
        // However, vanilla LLK/scratch-vm will reuse any canvas that we get here for other costumes,
        // which will cause bugs when Silhouette lazily reads the canvas data.
        // TurboWarp/scratch-vm does not reuse canvases and will set canvas.reusable = false.
        let textureData = clamped.data;
        if (textureData instanceof HTMLCanvasElement && textureData.reusable !== false) {
            const context = textureData.getContext('2d');
            textureData = context.getImageData(0, 0, textureData.width, textureData.height);
        }

        if (this._texture === null) {
            const textureOptions = {
                auto: false,
                wrap: gl.CLAMP_TO_EDGE
            };

            this._texture = twgl.createTexture(gl, textureOptions);
        }

        this._setTexture(textureData);

        // Do these last in case any of the above throws an exception
        this._costumeResolution = costumeResolution || 2;
        // Deliberately the ORIGINAL bitmap's size, not the size of the possibly
        // downscaled texture: `size` is derived from this, and the drawable's
        // rendered dimensions, the VM's costume.size and the stored
        // bitmapResolution must all stay exactly as they were. The texture is
        // simply stretched over the same quad at a lower texel density.
        this._textureSize = BitmapSkin._getBitmapSize(bitmapData);

        if (typeof rotationCenter === 'undefined') rotationCenter = this.calculateRotationCenter();
        this._rotationCenter[0] = rotationCenter[0];
        this._rotationCenter[1] = rotationCenter[1];

        this.emitWasAltered();
    }

    /**
     * Downscale bitmap data until neither dimension exceeds `maxDimension`.
     *
     * Returns the input untouched when it already fits, which is the case for
     * essentially every costume, so the common path is byte-for-byte what it
     * was before.
     *
     * The returned bitmap is used both as the texture source and (lazily, via
     * Skin._setTexture -> Silhouette.update) as the silhouette source, so both
     * buffers shrink together. Downscaling the silhouette is safe because
     * Silhouette samples it in normalised [0, 1] coordinates rather than in
     * texels, so `touching?` keeps working, just with coarser precision.
     *
     * @param {ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bitmapData - bitmap to inspect.
     * @param {number} maxDimension - longest edge to allow, in texels. Falsy disables the ceiling.
     * @returns {{data: object, scaled: boolean}} the uploadable bitmap, and whether it was resized
     * @private
     */
    static _clampBitmapSize (bitmapData, maxDimension) {
        if (!(maxDimension > 0)) {
            return {data: bitmapData, scaled: false};
        }

        const sourceSize = BitmapSkin._getBitmapSize(bitmapData);
        const longestEdge = Math.max(sourceSize[0], sourceSize[1]);
        if (!(longestEdge > maxDimension)) {
            return {data: bitmapData, scaled: false};
        }

        const ratio = maxDimension / longestEdge;
        const width = Math.max(1, Math.round(sourceSize[0] * ratio));
        const height = Math.max(1, Math.round(sourceSize[1] * ratio));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        // Ours, and never handed to the VM's canvas pool: tells the branch below
        // that it may upload the canvas directly instead of copying it into an
        // ImageData first, and keeps the silhouette's lazy read valid.
        canvas.reusable = false;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in context) {
            context.imageSmoothingQuality = 'high';
        }
        // drawImage accepts every type in the signature except ImageData, and an
        // ImageData source only appears for a VM-reused canvas, where the canvas
        // itself is still available -- callers pass the canvas, not its pixels.
        context.drawImage(bitmapData, 0, 0, width, height);
        return {data: canvas, scaled: true};
    }

    /**
     * @param {ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bitmapData - bitmap data to inspect.
     * @returns {Array<int>} the width and height of the bitmap data, in pixels.
     * @private
     */
    static _getBitmapSize (bitmapData) {
        if (bitmapData instanceof HTMLImageElement) {
            return [bitmapData.naturalWidth || bitmapData.width, bitmapData.naturalHeight || bitmapData.height];
        }

        if (bitmapData instanceof HTMLVideoElement) {
            return [bitmapData.videoWidth || bitmapData.width, bitmapData.videoHeight || bitmapData.height];
        }

        // ImageData or HTMLCanvasElement
        return [bitmapData.width, bitmapData.height];
    }

}

module.exports = BitmapSkin;
