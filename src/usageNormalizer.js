const INPUT_KEYS  = new Set(['prompt_tokens', 'input_tokens']);
const OUTPUT_KEYS = new Set(['completion_tokens', 'output_tokens']);
const TOTAL_KEYS  = new Set(['total_tokens', 'totalTokens']);
const COST_INPUT_KEYS  = new Set(['input_cost', 'prompt_cost', 'token_input_cost', 'cost_input']);
const COST_OUTPUT_KEYS = new Set(['output_cost', 'completion_cost', 'token_output_cost', 'cost_output']);
const COST_TOTAL_KEYS  = new Set(['total_cost', 'cost', 'totalCost']);
const COST_TOKEN_KEYS  = new Set(['token_cost']);

const ALL_KNOWN = new Set([
    ...INPUT_KEYS, ...OUTPUT_KEYS, ...TOTAL_KEYS,
    ...COST_INPUT_KEYS, ...COST_OUTPUT_KEYS, ...COST_TOTAL_KEYS, ...COST_TOKEN_KEYS
]);

function firstOf(obj, keys) {
    for (const k of keys) {
        if (obj[k] != null) return Number(obj[k]);
    }
    return null;
}

function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const input  = firstOf(raw, INPUT_KEYS);
    const output = firstOf(raw, OUTPUT_KEYS);
    let   total  = firstOf(raw, TOTAL_KEYS);
    if (total == null && input != null && output != null) total = input + output;

    const cost = {
        input:      firstOf(raw, COST_INPUT_KEYS),
        output:     firstOf(raw, COST_OUTPUT_KEYS),
        total:      firstOf(raw, COST_TOTAL_KEYS),
        tokenCost:  firstOf(raw, COST_TOKEN_KEYS)
    };

    const extra = [];
    for (const [k, v] of Object.entries(raw)) {
        if (!ALL_KNOWN.has(k) && v != null && typeof v !== 'object') {
            extra.push({ name: k, value: v });
        }
    }

    return { input, output, total, cost, extra };
}

module.exports = { normalizeUsage };
