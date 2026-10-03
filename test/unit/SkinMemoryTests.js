const test = require('tap').test;

// The unit tests run in plain Node, so there is no canvas. The fake below
// records every drawImage() as well as handing back plausible ImageData, which
// is all the skin code needs to be exercised and all the tests need to assert.
const drawCalls = [];
const makeContext = () => ({
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    drawImage: (...args) => drawCalls.push(args),
    putImageData: () => {},
    getImageData: (x, y, width, height) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    }),
    clearRect: () => {}
});

global.window = {};
// The skin code branches on these with instanceof, so the names have to resolve
// even though the unit tests only ever pass it plain {width, height} objects.
global.HTMLImageElement = class HTMLImageElement {};
global.HTMLVideoElement = class HTMLVideoElement {};
global.HTMLCanvasElement = class HTMLCanvasElement {};
global.ImageData = class ImageData {
    constructor (width, height) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
    }
};
global.document = {
    createElement: () => ({
        width: 0,
        height: 0,
        getContext: makeContext
    })
};

const Skin = require('../../src/Skin');
const Drawable = require('../../src/Drawable');
const BitmapSkin = require('../../src/BitmapSkin');
const RenderWebGL = require('../../src/RenderWebGL');

/**
 * @returns {RenderWebGL} a renderer with just enough state for the skin
 *     lifetime methods, built off the real prototype so the real
 *     destroyDrawable / destroySkin / releaseUnattachedSkins bodies run.
 */
const makeRendererStub = () => {
    const renderer = Object.create(RenderWebGL.prototype);
    renderer.dirty = false;
    renderer._allSkins = {};
    renderer._allDrawables = {};
    renderer._drawList = [];
    renderer._drawablePool = [];
    renderer._penSkinId = null;
    renderer._groupOrdering = ['group0'];
    renderer._layerGroups = {group0: {groupIndex: 0, drawListOffset: 0}};
    renderer.skinWasAltered = () => {};
    return renderer;
};

/**
 * @param {number} maxTextureDimension - texture ceiling to stub on the renderer.
 * @returns {BitmapSkin} a skin wired to a stubbed GL context.
 */
const makeBitmapSkin = (maxTextureDimension = 2048) => {
    const gl = {
        TEXTURE_2D: 1,
        CLAMP_TO_EDGE: 2,
        RGBA: 3,
        UNSIGNED_BYTE: 4,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL: 5,
        TEXTURE_WRAP_S: 6,
        TEXTURE_WRAP_T: 7,
        pixelStorei: () => {},
        texImage2D: () => {},
        deleteTexture: () => {},
        // twgl.createTexture drives these while setting up the empty texture.
        createTexture: () => ({}),
        bindTexture: () => {},
        texParameteri: () => {},
        activeTexture: () => {}
    };
    const renderer = makeRendererStub();
    // `gl` is a getter on the prototype, so it has to be backed by _gl.
    renderer._gl = gl;
    renderer._bindTexture = () => {};
    renderer.maxTextureDimension = maxTextureDimension;
    const skin = new BitmapSkin(0, renderer);
    // Pre-set the texture so setBitmap() skips twgl.createTexture, which
    // validates against real WebGL enum values that a stub cannot fake. The
    // bookkeeping under test -- texture size, silhouette source, dispose --
    // all still runs for real.
    skin._texture = {stub: true};
    return skin;
};

// ---------------------------------------------------------------------------
// Texture ceiling
// ---------------------------------------------------------------------------

test('a bitmap already under the ceiling is uploaded untouched', t => {
    const bitmap = {width: 640, height: 480};
    drawCalls.length = 0;

    const result = BitmapSkin._clampBitmapSize(bitmap, 2048);

    t.equal(result.data, bitmap, 'returns the same object, no copy and no redraw');
    t.equal(result.scaled, false);
    t.equal(drawCalls.length, 0);
    t.end();
});

test('a bitmap over the ceiling is downscaled to it', t => {
    const bitmap = {width: 4000, height: 2000};
    drawCalls.length = 0;

    const result = BitmapSkin._clampBitmapSize(bitmap, 2048);

    t.equal(result.scaled, true);
    t.equal(result.data.width, 2048, 'longest edge clamped');
    t.equal(result.data.height, 1024, 'aspect ratio preserved');
    t.equal(result.data.reusable, false, 'marked as ours so it is uploaded directly');
    t.equal(drawCalls.length, 1, 'one downscale draw');
    t.same(drawCalls[0].slice(1), [0, 0, 2048, 1024], 'drawn scaled, not cropped');
    t.end();
});

test('clamping a bitmap does not change the skin size the VM and renderer use', t => {
    const skin = makeBitmapSkin(2048);
    const bitmap = {width: 4000, height: 2000};

    skin.setBitmap(bitmap, 2);

    // The texture was uploaded at 2048x1024 (see the test above), but size must
    // still derive from the ORIGINAL bitmap, otherwise every oversized costume
    // would suddenly render at half scale and the stored bitmapResolution would
    // stop matching what the project says.
    t.same(skin._textureSize, [4000, 2000], 'geometry keeps the original texel size');
    t.same(skin.size, [2000, 1000], 'size is unchanged: 4000/2 x 2000/2');
    t.end();
});

test('a skin within the ceiling keeps its existing behaviour', t => {
    const skin = makeBitmapSkin(2048);
    const bitmap = {width: 200, height: 100};

    skin.setBitmap(bitmap, 2);

    t.same(skin._textureSize, [200, 100]);
    t.same(skin.size, [100, 50]);
    t.end();
});

// ---------------------------------------------------------------------------
// Silhouette ceiling
// ---------------------------------------------------------------------------

test('the silhouette is sampled from a reduced copy', t => {
    const source = Skin._silhouetteSource({width: 4000, height: 2000});

    t.equal(source.width, 256, 'capped to MAX_SILHOUETTE_DIMENSION');
    t.equal(source.height, 128, 'aspect ratio preserved');
    t.end();
});

test('a small bitmap is used for the silhouette as-is', t => {
    const bitmap = {width: 100, height: 100};

    t.equal(Skin._silhouetteSource(bitmap), bitmap);
    t.end();
});

test('a costume does not pin its full-resolution bitmap for the silhouette', t => {
    const skin = makeBitmapSkin(2048);
    const bitmap = {width: 4000, height: 2000};

    skin.setBitmap(bitmap, 2);

    // Silhouette.update() retains whatever it is handed until first use, so
    // handing it the costume itself would keep a second full copy of every
    // costume's pixels alive for the whole session.
    t.not(skin._silhouette._lazyData, bitmap, 'the costume bitmap is not retained');
    t.equal(skin._silhouette._width, 256, 'the retained source is the small copy');
    t.end();
});

// ---------------------------------------------------------------------------
// Releasing skins
// ---------------------------------------------------------------------------

test('destroySkin tolerates a skin that is already gone', t => {
    const renderer = makeRendererStub();
    renderer._allSkins = {1: new Skin(1, renderer)};

    renderer.destroySkin(1);
    // Scratch3Looks destroys a bubble drawable and then its skin, and destroying
    // the drawable releases the skin already, so this second call has to be a
    // no-op rather than a TypeError.
    renderer.destroySkin(1);
    renderer.destroySkin(12345);

    t.notOk(renderer._allSkins[1]);
    t.end();
});

test('destroyDrawable releases a skin no other drawable uses', t => {
    const renderer = makeRendererStub();
    const skin = new Skin(7, renderer);
    renderer._allSkins = {7: skin};
    const drawable = new Drawable(0, renderer);
    drawable.skin = skin;
    renderer._allDrawables = {0: drawable};
    renderer._drawList = [0];

    renderer.destroyDrawable(0, 'group0');

    t.notOk(renderer._allSkins[7], 'the texture and silhouette are handed back');
    t.end();
});

test('destroyDrawable keeps a skin a clone is still drawing with', t => {
    const renderer = makeRendererStub();
    const skin = new Skin(7, renderer);
    renderer._allSkins = {7: skin};
    const original = new Drawable(0, renderer);
    const clone = new Drawable(1, renderer);
    original.skin = skin;
    clone.skin = skin; // clones share their original's costume skins
    renderer._allDrawables = {0: original, 1: clone};
    renderer._drawList = [0, 1];

    renderer.destroyDrawable(0, 'group0');

    t.ok(renderer._allSkins[7], 'still referenced by the clone');
    t.end();
});

test('releaseUnattachedSkins frees orphans and spares what is still in use', t => {
    const renderer = makeRendererStub();
    const displayed = new Skin(1, renderer);
    const otherCostume = new Skin(2, renderer);
    const penSkin = new Skin(3, renderer);
    renderer._allSkins = {1: displayed, 2: otherCostume, 3: penSkin};
    renderer._penSkinId = 3;
    const drawable = new Drawable(0, renderer);
    drawable.skin = displayed;

    renderer.releaseUnattachedSkins();

    t.ok(renderer._allSkins[1], 'the costume being drawn keeps its texture');
    t.notOk(renderer._allSkins[2], 'the unselected costume is released');
    t.ok(renderer._allSkins[3], 'the pen layer survives: it is cached across projects');
    t.end();
});

test('a disposed skin hands back its silhouette buffer', t => {
    const skin = makeBitmapSkin(2048);
    skin.setBitmap({width: 4000, height: 2000}, 2);
    skin._silhouette.unlazy();
    t.ok(skin._silhouette._colorData, 'silhouette materialised');

    skin.dispose();

    t.notOk(skin._silhouette._colorData, 'pixel buffer released');
    t.notOk(skin._silhouette._lazyData, 'lazy source released');
    t.equal(skin._silhouette._width, 0);
    t.end();
});
