export const waterfallVertexShader = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

export const waterfallFragmentShader = `
precision highp float;
uniform sampler2D history;
uniform sampler2D palette;
uniform vec2 textureSize;
uniform vec2 viewport;
uniform float tiles;
uniform float slots;
uniform float rows;
uniform float current;
uniform float validRows;
uniform float fraction;
uniform float offset;
uniform float zoom;
uniform float bins;
uniform float levelOffset;
uniform float levelBins;
uniform float levelScale;
uniform vec2 range;
// Waterfall smoothing: weight of each older row, 0 for none.
uniform float keep;

float powerAt(float index, float slot) {
    float location = levelOffset + clamp(index, 0.0, levelBins - 1.0);
    vec2 uv = vec2(mod(location, textureSize.x) + 0.5, slot * tiles + floor(location / textureSize.x) + 0.5) / textureSize;
    vec4 encodedPower = texture2D(history, uv);
    return -192.0 + (encodedPower.r * 65280.0 + encodedPower.a * 255.0) * (256.0 / 65535.0);
}

float peakAt(float row) {
    float slot = mod(current - row + slots, slots);
    float left = (offset + (gl_FragCoord.x - 0.5) / viewport.x / zoom) * bins / levelScale;
    float right = (offset + (gl_FragCoord.x + 0.5) / viewport.x / zoom) * bins / levelScale;
    float first = floor(left);
    float peak = -192.0;
    for (int i = 0; i < 5; i++) {
        float index = first + float(i);
        if (index < ceil(right)) peak = max(peak, powerAt(index, slot));
    }
    return peak;
}

// Each shown row averages itself with the older rows below it, so the whole
// history follows the smoothing setting, not just the rows drawn after a change.
vec4 colourAt(float row) {
    if (row > validRows) return vec4(0.0, 0.0, 0.0, 1.0);
    float total = peakAt(row);
    float weight = 1.0;
    float w = keep;
    for (int k = 1; k < 16; k++) {
        if (w < 0.02 || row + float(k) > validRows) break;
        total += w * peakAt(row + float(k));
        weight += w;
        w *= keep;
    }
    float normalized = clamp((total / weight - range.x) / (range.y - range.x), 0.0, 1.0);
    return texture2D(palette, vec2((normalized * 255.0 + 0.5) / 256.0, 0.5));
}

void main() {
    float row = clamp((1.0 - gl_FragCoord.y / viewport.y) * rows - fraction + 1.0, 0.0, rows);
    gl_FragColor = mix(colourAt(floor(row)), colourAt(min(floor(row) + 1.0, rows)), fract(row));
}
`;
