const openai     = require('./openai');
const geminiJank = require('./gemini-jank');
const gemini     = require('./gemini');
const askSage    = require('./ask-sage');

const registry = {
    'openai':      openai,
    'gemini-jank': geminiJank,
    'gemini':      gemini,
    'ask-sage':    askSage
};

function getAdapter(id) {
    return registry[id] || null;
}

function listAdapters() {
    return Object.values(registry).map(a => ({ id: a.id, name: a.name }));
}

module.exports = { getAdapter, listAdapters };
