var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var test = require('node:test');
var discoverEmbeddedASS = require('../src/embeddedASSCompatibility');

var mediaURL = 'https://media.example.test/video.mkv';
var fixture = fs.readFileSync(path.join(__dirname, 'fixtures/synthetic-h264-srt-ass.mkv'));

function partialResponse(range) {
    var match = /^bytes=(\d+)-(\d+)$/.exec(range);
    var start = Number(match[1]);
    var end = Math.min(Number(match[2]), fixture.length - 1);
    return new Response(fixture.subarray(start, end + 1), {
        status: 206,
        headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + fixture.length }
    });
}

test('extracts the embedded ASS track and reuses the initial range across windows', async function(t) {
    var request = t.mock.method(globalThis, 'fetch', async function(_url, init) {
        return partialResponse(new Headers(init.headers).get('Range'));
    });

    var tracks = await discoverEmbeddedASS(mediaURL);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].codec, 'ass');
    assert.match(await tracks[0].loadWindow(0, 3000), /Dialogue:.*0:00:01\.00,0:00:04\.00/);
    assert.match(await tracks[0].loadWindow(4000, 8000), /TESTE 2 - segunda legenda/);
    assert.equal(request.mock.callCount(), 1);
});

test('continues from the next byte when the origin returns only part of the requested range', async function(t) {
    var requests = [];
    t.mock.method(globalThis, 'fetch', async function(_url, init) {
        var range = new Headers(init.headers).get('Range');
        var start = Number(/^bytes=(\d+)-/.exec(range)[1]);
        requests.push(start);
        var end = Math.min(start + 2047, fixture.length - 1);
        return new Response(fixture.subarray(start, end + 1), {
            status: 206,
            headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + fixture.length }
        });
    });
    var tracks = await discoverEmbeddedASS(mediaURL);
    assert.equal(tracks.length, 1);
    assert.match(await tracks[0].loadWindow(0, 8000), /TESTE 2 - segunda legenda/);
    assert.deepEqual(requests, [0, 2048, 4096, 6144]);
});

test('cancels the body if the origin ignores Range', async function(t) {
    var cancelled = false;
    var body = new ReadableStream({ cancel: function() { cancelled = true; } });
    t.mock.method(globalThis, 'fetch', async function() { return new Response(body, { status: 200 }); });

    await assert.rejects(discoverEmbeddedASS(mediaURL), /valid partial media response/);
    assert.equal(cancelled, true);
});

test('rejects mismatched ranges and truncated bodies', async function(t) {
    var request = t.mock.method(globalThis, 'fetch', async function() {
        return new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 1-9/10' } });
    });
    await assert.rejects(discoverEmbeddedASS(mediaURL), /valid partial media response/);

    request.mock.mockImplementation(async function() {
        return new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 0-9/10' } });
    });
    await assert.rejects(discoverEmbeddedASS(mediaURL), /Truncated media range/);
});

test('rejects a window after media unload or seek cancellation', async function(t) {
    var request = t.mock.method(globalThis, 'fetch', async function(_url, init) {
        return partialResponse(new Headers(init.headers).get('Range'));
    });
    var playback = new AbortController();
    var seek = new AbortController();
    var tracks = await discoverEmbeddedASS(mediaURL, { signal: playback.signal });
    seek.abort();
    await assert.rejects(tracks[0].loadWindow(0, 8000, seek.signal), /cancelled/);
    assert.match(await tracks[0].loadWindow(0, 8000), /Dialogue:/);
    playback.abort();
    await assert.rejects(tracks[0].loadWindow(0, 8000), /cancelled/);
    assert.equal(request.mock.callCount(), 1);
});
