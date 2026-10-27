const test = require('tap').test;

// Plain Node, no DOM. The stubs below cover everything SVGSkin touches, and the
// `src` of the fake <img> is the observable: setSVG() assigns it exactly when it
// starts the deferred materialization, which is the whole question these tests
// are about.

/** The viewBox loadSvgString() should report for the next setSVG() call. */
let nextViewBox = {x: 0, y: 0, width: 100, height: 100};

const makeContext = () => ({
    drawImage: () => {},
    clearRect: () => {},
    setTransform: () => {},
    getImageData: (x, y, width, height) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    })
});

global.window = {};
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
    createElement: () => {
        const element = {
            width: 0,
            height: 0,
            getContext: makeContext,
            // SVGSkin assigns these; `src` doubles as the "load started" flag.
            src: '',
            onload: null
        };
        return element;
    }
};

// The real parser and the font inliner both need a DOM, and what is under test
// is *when* materialization starts, not what it produces. Both are destructured
// at require time, so they have to be replaced before SVGSkin is loaded.
const svgRenderer = require('@bilup/scratch-svg-renderer');
svgRenderer.loadSvgString = () => ({viewBox: {baseVal: nextViewBox}});
svgRenderer.serializeSvgToString = () => '<svg viewBox="0 0 100 100"/>';

const Drawable = require('../../src/Drawable');
const RenderWebGL = require('../../src/RenderWebGL');
const SVGSkin = require('../../src/SVGSkin');

/**
 * @returns {RenderWebGL} a renderer with just enough state for an SVGSkin, built
 *     off the real prototype so real skin code runs.
 */
const makeRenderer = () => {
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
        createTexture: () => ({}),
        bindTexture: () => {},
        texParameteri: () => {},
        activeTexture: () => {}
    };
    const renderer = Object.create(RenderWebGL.prototype);
    renderer.dirty = false;
    renderer.customFonts = [];
    renderer._gl = gl;
    renderer._bindTexture = () => {};
    renderer.maxTextureDimension = 2048;
    // A real renderer marks itself dirty here; that is what eventually asks for
    // the skin's texture. Record it instead.
    renderer.alteredCount = 0;
    renderer.skinWasAltered = () => {
        renderer.dirty = true;
        renderer.alteredCount++;
    };
    return renderer;
};

/**
 * @param {RenderWebGL} renderer The renderer the skin belongs to.
 * @returns {SVGSkin} an unloaded SVG skin.
 */
const makeSkin = renderer => {
    nextViewBox = {x: 0, y: 0, width: 100, height: 100};
    return new SVGSkin(0, renderer);
};

// ---------------------------------------------------------------------------
// Deferred materialization
// ---------------------------------------------------------------------------

test('a costume nobody is showing stays deferred', t => {
    const renderer = makeRenderer();
    const skin = makeSkin(renderer);

    skin.setSVG('<svg viewBox="0 0 100 100"/>', [50, 50]);

    t.equal(skin._svgImage.src, '', 'no image load started');
    t.equal(skin._pendingSVGStarted, false, 'work is still pending');
    t.equal(renderer.alteredCount, 0, 'nothing was reported as altered');
    t.end();
});

test('a costume that is on screen starts loading immediately', t => {
    const renderer = makeRenderer();
    const skin = makeSkin(renderer);
    const drawable = new Drawable(1, renderer);
    drawable.skin = skin;

    skin.setSVG('<svg viewBox="0 0 100 100"/>', [50, 50]);

    // Regression: this used to stay empty until something else asked for the
    // texture. RenderWebGL.draw() is skipped while nothing on the stage moves,
    // and the only thing that made it run again was the WasAltered event of a
    // load that had not started -- so the edit was invisible until the user
    // reselected the sprite.
    t.notEqual(skin._svgImage.src, '', 'the image load has started');
    t.equal(skin._pendingSVGStarted, true, 'the deferred work was taken');
    t.end();
});

test('editing a costume that came off screen is deferred again', t => {
    const renderer = makeRenderer();
    const skin = makeSkin(renderer);
    const drawable = new Drawable(1, renderer);
    drawable.skin = skin;
    drawable.skin = null;

    skin.setSVG('<svg viewBox="0 0 100 100"/>', [50, 50]);

    t.equal(skin._svgImage.src, '', 'no image load started for a skin nothing shows');
    t.end();
});

// ---------------------------------------------------------------------------
// Empty costumes
// ---------------------------------------------------------------------------

test('emptying a costume drops the pixels of its previous version', t => {
    const renderer = makeRenderer();
    const skin = makeSkin(renderer);
    const drawable = new Drawable(1, renderer);
    drawable.skin = skin;

    // Materialize the costume at its real size, then empty it.
    skin.setSVG('<svg viewBox="0 0 100 100"/>', [50, 50]);
    const image = skin._svgImage;
    image.onload();

    t.equal(skin._svgImageLoaded, true, 'the first version loaded');

    // What getTexture() would have handed the renderer for the old artwork.
    skin._scaledMIPs[8] = {stub: 'old artwork'};
    skin._largestMIPScale = 1;
    // Skips twgl.createTexture(), which validates real WebGL enums a stub
    // cannot fake; the empty texture itself is not what this test is about.
    skin._emptyImageData = {stub: 'empty'};

    nextViewBox = {x: 0, y: 0, width: 0, height: 0};
    skin.setSVG('<svg viewBox="0 0 0 0"/>', [0, 0]);
    // A skin reuses one <img>, so this is the same element with a new handler.
    image.onload();

    // Regression: the MIPs of the previous version used to stay in place, and
    // getTexture() prefers them over the empty texture, so an emptied costume
    // kept showing its old artwork.
    t.equal(skin._scaledMIPs.length, 0, 'the old MIPs are gone');
    // Deliberately still false: it only gates MIP creation, and a zero-sized
    // image cannot produce one -- createMIP() would hand back the shared empty
    // texture, which resetMIPs() would then delete out from under every later
    // fallback of this skin.
    t.equal(skin._svgImageLoaded, false, 'no MIP is expected for an empty costume');
    t.notOk(skin.getTexture([100, 100]), 'getTexture() falls back to the shared empty texture');
    t.equal(skin._scaledMIPs.length, 0, 'and does not cache that fallback');
    t.end();
});

test('a MIP that fell back to the shared empty texture is not cached', t => {
    const renderer = makeRenderer();
    const skin = makeSkin(renderer);

    // What createMIP() returns for a costume whose image is too small to draw:
    // the skin's own shared empty texture, not a texture it owns.
    const emptyTexture = {stub: 'shared empty texture'};
    skin._emptyImageTexture = emptyTexture;
    skin._svgImageLoaded = true;
    skin.createMIP = () => emptyTexture;

    t.equal(skin.getTexture([100, 100]), emptyTexture, 'the fallback is used');

    // Regression guard: caching it would put the shared texture in _scaledMIPs,
    // where the next setSVG() -> resetMIPs() deletes it, leaving this skin
    // permanently drawing with a destroyed texture.
    t.equal(skin._scaledMIPs.length, 0, 'but it is never cached as a MIP');
    t.end();
});
