import './util';
import { describe, test } from 'vitest';
import { assert } from 'chai';

import { schema, t, Encoder, Decoder, Reflection, type SchemaType } from '@colyseus/schema';

import { SchemaSerializer } from '../src/serializer/SchemaSerializer.ts';

// Regression: a MapSchema key containing a lone surrogate (code point
// 55296 / 0xD800) corrupted the state stream. The encoder wrote the key as
// 4 bytes (assuming a surrogate pair) while the length prefix said 3
// (Buffer.byteLength replaces lone surrogates with U+FFFD), so every field
// after the key decoded one byte off — on the canvas, the new player and
// every already-synced player collapsed to (0, 0).
//
// Mirror of the example app (packages/example/src/MyRoom.ts): an 800x600
// map and a `players` map of { x, y, score } keyed by session id.

const Player = schema({ x: t.number(), y: t.number(), score: t.number() }, 'LoneSurrogatePlayer');
type Player = SchemaType<typeof Player>;

const State = schema({
    mapWidth: t.number(),
    mapHeight: t.number(),
    players: t.map(Player),
}, 'LoneSurrogateState');
type State = SchemaType<typeof State>;

// the marker from the bug report: code point 55296, an unpaired surrogate
const MARKER = String.fromCodePoint(55296);

function createRoom() {
    const state = new State();
    state.mapWidth = 800;
    state.mapHeight = 600;
    return { state, encoder: new Encoder(state) };
}

function createCanvas() {
    return new SchemaSerializer();
}

function joinCanvas(serializer: SchemaSerializer, encoder: Encoder<State>) {
    serializer.handshake(Reflection.encode(encoder));
    serializer.setState(encoder.encodeAll());
    return serializer.getState() as State;
}

function addPlayer(state: State, key: string, x: number, y: number, score: number) {
    const player = new Player();
    player.x = x;
    player.y = y;
    player.score = score;
    state.players.set(key, player);
    return player;
}

function assertPositions(decoded: State, entries: Array<[string, number, number, number]>) {
    assert.strictEqual(decoded.players.size, entries.length, "player count");
    for (const [key, x, y, score] of entries) {
        const player = decoded.players.get(key);
        if (!player) {
            assert.fail(`player for key ${JSON.stringify(key)} must exist`);
        }
        assert.strictEqual(player.x, x, `x of key ${JSON.stringify(key)}`);
        assert.strictEqual(player.y, y, `y of key ${JSON.stringify(key)}`);
        assert.strictEqual(player.score, score, `score of key ${JSON.stringify(key)}`);
    }
}

describe('state sync with lone-surrogate map keys', () => {

    test('joining with a lone-surrogate key must not move existing players', () => {
        const { state, encoder } = createRoom();
        const canvas = createCanvas();

        // hero is placed first
        addPlayer(state, 'hero', 100, 200, 1);
        const decoded = joinCanvas(canvas, encoder);
        assertPositions(decoded, [['hero', 100, 200, 1]]);

        // a second player joins under the lone-surrogate marker
        addPlayer(state, MARKER, 320, 240, 4);
        canvas.patch(encoder.encode());

        // canvas: both players at their recorded spots, hero untouched
        assertPositions(decoded, [['hero', 100, 200, 1], [MARKER, 320, 240, 4]]);
        assert.strictEqual(decoded.mapWidth, 800);
        assert.strictEqual(decoded.mapHeight, 600);

        // the marker itself must survive the round-trip unchanged
        const keys: string[] = [];
        decoded.players.forEach((_, key) => keys.push(key));
        assert.include(keys, MARKER, "marker key must decode back to the same string");
    });

    test('re-reading the same state lands on the same coordinates', () => {
        const { state, encoder } = createRoom();
        addPlayer(state, 'hero', 100, 200, 1);
        addPlayer(state, MARKER, 320, 240, 4);

        const fullState = encoder.encodeAll();

        // canvas (SDK serializer) reads it
        const canvas = createCanvas();
        canvas.handshake(Reflection.encode(encoder));
        canvas.setState(fullState);
        assertPositions(canvas.getState() as State, [['hero', 100, 200, 1], [MARKER, 320, 240, 4]]);

        // a fresh decoder re-reading the same bytes agrees
        const reread = new State();
        new Decoder(reread).decode(fullState);
        assertPositions(reread, [['hero', 100, 200, 1], [MARKER, 320, 240, 4]]);
    });

    test('single player round-trips (baseline)', () => {
        const { state, encoder } = createRoom();
        addPlayer(state, 'hero', 320, 240, 1);

        const decoded = joinCanvas(createCanvas(), encoder);
        assertPositions(decoded, [['hero', 320, 240, 1]]);
    });

    test('moving a player moves the circle (baseline)', () => {
        const { state, encoder } = createRoom();
        const hero = addPlayer(state, 'hero', 120, 80, 1);

        const canvas = createCanvas();
        const decoded = joinCanvas(canvas, encoder);
        assertPositions(decoded, [['hero', 120, 80, 1]]);

        hero.x = 460;
        hero.y = 275;
        canvas.patch(encoder.encode());
        assertPositions(decoded, [['hero', 460, 275, 1]]);
    });

    test('string codec round-trips lone surrogates, pairs and mixed keys', () => {
        const keys = [
            MARKER,                                 // lone high surrogate
            String.fromCodePoint(56320),            // lone low surrogate
            '😀',                                   // valid surrogate pair
            'a' + MARKER + 'b',                     // lone surrogate inside text
            MARKER + 'A',                           // high surrogate not followed by low
            '😀' + MARKER,                          // pair followed by lone surrogate
        ];

        for (const key of keys) {
            const { state, encoder } = createRoom();
            addPlayer(state, 'hero', 100, 200, 1);
            addPlayer(state, key, 320, 240, 4);

            const decoded = joinCanvas(createCanvas(), encoder);
            assertPositions(decoded, [['hero', 100, 200, 1], [key, 320, 240, 4]]);
        }
    });

});
