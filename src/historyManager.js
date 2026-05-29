const MAX_SESSIONS = 50;

class HistoryManager {
    constructor(context) {
        this._ctx = context;
    }

    getSessions() {
        return this._ctx.globalState.get('sa_sessions', []);
    }

    saveSession(session) {
        const sessions = this.getSessions();
        const idx = sessions.findIndex(s => s.id === session.id);
        if (idx >= 0) {
            sessions[idx] = session;
        } else {
            sessions.unshift(session);
        }
        if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
        return this._ctx.globalState.update('sa_sessions', sessions);
    }

    deleteSession(id) {
        const sessions = this.getSessions().filter(s => s.id !== id);
        return this._ctx.globalState.update('sa_sessions', sessions);
    }

    clearAll() {
        return this._ctx.globalState.update('sa_sessions', []);
    }

    createSession() {
        return {
            id: `s_${Date.now()}`,
            title: 'New Chat',
            created: new Date().toISOString(),
            messages: []
        };
    }
}

module.exports = HistoryManager;
