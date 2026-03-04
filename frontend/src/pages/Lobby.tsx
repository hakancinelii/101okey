// src/pages/Lobby.tsx
import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { io, Socket } from 'socket.io-client';
import { BACKEND_URL } from '../config';

interface Member {
    id: string;
    name: string;
    ready: boolean;
    host: boolean;
    isBot?: boolean;
    seat: number;
}

interface ChatMessage {
    user: string;
    text: string;
}

const Lobby: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { lobbyId } = useParams<{ lobbyId: string }>();
    const [members, setMembers] = useState<Member[]>([]);
    const [ready, setReady] = useState(false);
    const [settings, setSettings] = useState({
        maxRounds: 3,
        turnTime: 60,
        gameMode: 'NORMAL',
        startingScore: 101
    });
    const [isHost, setIsHost] = useState(false);
    const [chat, setChat] = useState<ChatMessage[]>([]);
    const [msgInput, setMsgInput] = useState('');
    const socketRef = useRef<Socket | null>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);

    const token = localStorage.getItem('token') || '';

    const getUserInfo = () => {
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            return { id: payload.userId, name: payload.email || 'Player' };
        } catch (e) {
            return { id: '', name: 'Player' };
        }
    };

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chat]);

    useEffect(() => {
        const socket = io(BACKEND_URL, {
            auth: { token },
            transports: ['polling', 'websocket'],
            reconnectionAttempts: 5,
            timeout: 10000
        });
        socketRef.current = socket;

        socket.on('connect_error', (err) => {
            console.error('Lobby Socket Connect Error:', err.message);
        });

        socket.on('connect', () => {
            const lobby = lobbyId || 'default';
            socket.emit('joinLobby', lobby, (err?: string) => {
                if (err) {
                    alert(t('error') + ': ' + err);
                    navigate('/dashboard');
                }
            });
        });

        socket.on('lobbyUpdate', (data: any) => {
            const updatedMembers = data.members || [];
            const updatedSettings = data.settings || settings;

            setMembers(updatedMembers);
            setSettings(updatedSettings);

            const me = getUserInfo();
            const myMember = updatedMembers.find((m: any) => m.id === me.id);
            if (myMember) setReady(myMember.ready);
            const hostMember = updatedMembers.find((m: any) => m.host);
            setIsHost(hostMember?.id === me.id);
        });

        socket.on('readyStatus', (status: boolean) => setReady(status));
        socket.on('chatMessage', (msg: ChatMessage) => setChat((prev) => [...prev, msg]));

        socket.on('gameStarted', (data: { gameId: string, hand: any[], okeyTile?: any, deckCount?: number, turnIndex?: number, members?: any[] }) => {
            navigate(`/game/${data.gameId}`, {
                state: {
                    initialHand: data.hand,
                    okeyTile: data.okeyTile,
                    deckCount: data.deckCount,
                    turnIndex: data.turnIndex,
                    members: data.members
                }
            });
        });

        return () => { socket.disconnect(); };
    }, [lobbyId, navigate, token]);

    const toggleReady = () => {
        if (!socketRef.current || !lobbyId) return;
        socketRef.current.emit('setReady', { lobbyId, isReady: !ready });
    };

    const updateSettings = (newSettings: any) => {
        if (!socketRef.current || !isHost || !lobbyId) return;
        socketRef.current.emit('updateSettings', { lobbyId, settings: { ...settings, ...newSettings } }, (err?: string) => {
            if (err) alert(err);
        });
    };

    const startGame = () => {
        if (!socketRef.current || !lobbyId) return;
        socketRef.current.emit('startGame', lobbyId, {}, (err?: string) => {
            if (err) alert(err);
        });
    };

    const resetGame = () => {
        if (!socketRef.current || !isHost || !lobbyId) return;
        if (!window.confirm('Masayı sıfırlamak istediğinize emin misiniz?')) return;
        socketRef.current.emit('resetGame', lobbyId, (err?: string) => {
            if (err) alert(err);
        });
    };

    const addBot = () => {
        if (!socketRef.current || !isHost || !lobbyId) return;
        socketRef.current.emit('addBot', lobbyId, (err?: string) => {
            if (err) alert(err);
        });
    };

    const removeBot = (botUserId: string) => {
        if (!socketRef.current || !isHost) return;
        socketRef.current.emit('removeBot', botUserId, (err?: string) => {
            if (err) alert(err);
        });
    };

    const sendMessage = (e: React.FormEvent) => {
        e.preventDefault();
        if (!msgInput.trim() || !socketRef.current) return;
        const userInfo = getUserInfo();
        socketRef.current.emit('chatMessage', { user: userInfo.name, text: msgInput });
        setMsgInput('');
    };

    return (
        <div className="min-h-screen bg-okey-table flex flex-col items-center justify-center p-6 text-white font-sans overflow-hidden">
            {/* Ambient Background */}
            <div className="absolute top-0 inset-x-0 h-64 bg-gradient-to-b from-black/40 to-transparent"></div>

            <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-3 gap-8 z-10 animate-in fade-in zoom-in-95 duration-500">

                {/* Left Side: Lobby Info & Actions */}
                <div className="lg:col-span-2 flex flex-col space-y-6">
                    <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                            <h1 className="text-3xl font-black tracking-tight uppercase">{t('lobby')}</h1>
                            <span className="text-[10px] font-black opacity-40 tracking-[0.2em] uppercase">Masa ID: #{lobbyId?.slice(-4).toUpperCase() || 'DEFAULT'}</span>
                        </div>
                        <button
                            onClick={() => navigate('/dashboard')}
                            className="w-10 h-10 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-xl border border-white/10 transition-all"
                        >
                            ✕
                        </button>
                    </div>

                    {/* Players Grid */}
                    <div className="grid grid-cols-2 gap-4">
                        {[0, 1, 2, 3].map((idx) => {
                            const member = members.find(m => m.seat === idx);
                            return (
                                <div key={idx} className={`h-32 glass-hud rounded-[32px] border transition-all duration-300 flex items-center px-6 relative overflow-hidden group ${member ? 'border-white/10' : 'border-dashed border-white/5 opacity-50'}`}>
                                    {member ? (
                                        <>
                                            <div className="relative">
                                                <div className={`w-16 h-16 rounded-full overflow-hidden border-2 transition-all ${member.ready ? 'border-green-400 shadow-[0_0_15px_rgba(34,197,94,0.4)]' : 'border-white/20'}`}>
                                                    <img src={`https://api.dicebear.com/7.x/pixel-art/svg?seed=${member.id}`} alt="avatar" className="w-full h-full object-cover" />
                                                </div>
                                                {member.host && (
                                                    <div className="absolute -top-1 -left-1 bg-amber-500 text-[8px] font-black px-1.5 py-0.5 rounded-full shadow-lg border border-black/20">HOST</div>
                                                )}
                                            </div>
                                            <div className="ml-4 flex flex-col">
                                                <span className="text-lg font-black uppercase tracking-tight truncate max-w-[120px]">{member.name}</span>
                                                <span className={`text-[10px] font-black uppercase tracking-widest ${member.ready ? 'text-green-400' : 'text-white/30'}`}>
                                                    {member.ready ? t('ready') : 'BEKLİYOR'}
                                                </span>
                                            </div>
                                            {member.ready && (
                                                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-2xl text-green-400 animate-pulse">✓</div>
                                            )}
                                            {isHost && member.isBot && (
                                                <button
                                                    onClick={() => removeBot(member.id)}
                                                    className="absolute top-2 right-2 text-[8px] bg-red-500/20 text-red-500 px-2 py-1 rounded-lg hover:bg-red-500 hover:text-white transition-all font-black uppercase"
                                                >
                                                    KALDIR
                                                </button>
                                            )}
                                        </>
                                    ) : (
                                        <div className="w-full flex flex-col items-center justify-center space-y-2">
                                            <span className="text-[10px] font-black opacity-20 uppercase tracking-widest">BOŞ KOLTUK</span>
                                            {isHost && (
                                                <button
                                                    onClick={addBot}
                                                    className="px-4 py-1.5 bg-white/5 hover:bg-white/10 text-[9px] font-black uppercase rounded-full border border-white/10 transition-all text-white/40 hover:text-white"
                                                >
                                                    + BOT EKLE
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Action Buttons */}
                    <div className="flex space-x-4 pt-4">
                        <button
                            onClick={toggleReady}
                            className={`flex-1 h-14 btn-premium ${ready ? 'btn-red' : 'btn-green'} text-xs tracking-widest`}
                        >
                            {ready ? 'HAZIR DEĞİL' : 'HAZIRIM!'}
                        </button>
                        {isHost && (
                            <button
                                onClick={startGame}
                                disabled={members.length < 2}
                                className={`flex-1 h-14 btn-premium btn-amber text-xs tracking-widest ${members.length < 2 ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                                {t('startGame')}
                            </button>
                        )}
                        {isHost && (
                            <button
                                onClick={resetGame}
                                className="w-14 h-14 flex items-center justify-center btn-premium btn-red rounded-2xl"
                                title="Masayı Sıfırla"
                            >
                                🔄
                            </button>
                        )}
                    </div>

                    <div className="glass-hud rounded-[24px] p-6 border border-white/10 flex flex-col space-y-6 animate-in slide-in-from-left duration-700">
                        <div className="flex items-center justify-between border-b border-white/5 pb-4">
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-500">Gelişmiş Oyun Ayarları</span>
                        </div>

                        {/* Rounds */}
                        <div className="flex flex-col space-y-3">
                            <div className="flex justify-between items-center px-1">
                                <span className="text-[11px] font-black uppercase tracking-widest text-white/40">Maksimum El</span>
                                <span className="text-amber-500 text-[10px] font-black uppercase">{settings.maxRounds} EL</span>
                            </div>
                            <div className="flex items-center space-x-2">
                                {[1, 3, 5, 7].map(r => (
                                    <button
                                        key={r}
                                        disabled={!isHost}
                                        onClick={() => updateSettings({ maxRounds: r })}
                                        className={`flex-1 h-10 rounded-xl border flex items-center justify-center font-black transition-all text-xs
                                             ${settings.maxRounds === r ? 'bg-amber-500 border-amber-400 text-black shadow-lg' : 'bg-white/5 border-white/5 text-white/40 hover:bg-white/10'}`}
                                    >
                                        {r}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Turn Time */}
                        <div className="flex flex-col space-y-3">
                            <div className="flex justify-between items-center px-1">
                                <span className="text-[11px] font-black uppercase tracking-widest text-white/40">Sıra Süresi</span>
                                <span className="text-amber-500 text-[10px] font-black uppercase">{settings.turnTime} SN</span>
                            </div>
                            <div className="flex items-center space-x-2">
                                {[30, 60, 90, 120].map(t => (
                                    <button
                                        key={t}
                                        disabled={!isHost}
                                        onClick={() => updateSettings({ turnTime: t })}
                                        className={`flex-1 h-10 rounded-xl border flex items-center justify-center font-black transition-all text-xs
                                             ${settings.turnTime === t ? 'bg-amber-500 border-amber-400 text-black shadow-lg' : 'bg-white/5 border-white/5 text-white/40 hover:bg-white/10'}`}
                                    >
                                        {t}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4 pt-2">
                            {/* Game Mode */}
                            <div className="flex flex-col space-y-3">
                                <span className="text-[11px] font-black uppercase tracking-widest text-white/40 px-1">Oyun Modu</span>
                                <button
                                    disabled={!isHost}
                                    onClick={() => updateSettings({ gameMode: settings.gameMode === 'NORMAL' ? 'FOLDING' : 'NORMAL' })}
                                    className={`h-11 rounded-xl border flex items-center justify-center font-black transition-all text-[10px] uppercase tracking-widest
                                        ${settings.gameMode === 'FOLDING' ? 'bg-amber-500 border-amber-400 text-black' : 'bg-white/5 border-white/5 text-white/40'}`}
                                >
                                    {settings.gameMode === 'FOLDING' ? '🔥 KATLAMALI' : 'NORMAL'}
                                </button>
                            </div>

                            {/* Starting Score */}
                            <div className="flex flex-col space-y-3">
                                <span className="text-[11px] font-black uppercase tracking-widest text-white/40 px-1">Baraj Puanı</span>
                                <button
                                    disabled={!isHost}
                                    onClick={() => updateSettings({ startingScore: settings.startingScore === 101 ? 202 : 101 })}
                                    className={`h-11 rounded-xl border flex items-center justify-center font-black transition-all text-[10px] uppercase tracking-widest
                                        ${settings.startingScore === 202 ? 'bg-blue-500 border-blue-400 text-white' : 'bg-white/5 border-white/5 text-white/40'}`}
                                >
                                    {settings.startingScore} PUAN
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Side: Chat */}
                <div className="glass-hud rounded-[40px] border border-white/10 flex flex-col overflow-hidden shadow-3xl h-[500px] lg:h-auto">
                    <div className="p-6 border-b border-white/5 bg-white/5 flex items-center justify-between">
                        <h3 className="text-sm font-black uppercase tracking-widest">{t('chat')}</h3>
                        <div className="flex space-x-1">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
                            <span className="text-[10px] font-black opacity-60 uppercase">{members.length} ONLINE</span>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-6 space-y-4 no-scrollbar">
                        {chat.map((msg, idx) => (
                            <div key={idx} className={`flex flex-col ${msg.user === getUserInfo().name ? 'items-end' : 'items-start'}`}>
                                <span className="text-[9px] font-black opacity-40 uppercase mb-1">{msg.user}</span>
                                <div className={`px-4 py-2 rounded-2xl text-[13px] max-w-[80%] ${msg.user === getUserInfo().name ? 'bg-amber-500/20 border border-amber-500/20 text-amber-50' : 'bg-white/5 border border-white/10 text-white'}`}>
                                    {msg.text}
                                </div>
                            </div>
                        ))}
                        <div ref={chatEndRef} />
                    </div>

                    <form onSubmit={sendMessage} className="p-4 bg-black/40 border-t border-white/5 flex space-x-2">
                        <input
                            type="text"
                            value={msgInput}
                            onChange={(e) => setMsgInput(e.target.value)}
                            placeholder={t('typeMessage')}
                            className="flex-1 bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-amber-500 transition-colors"
                        />
                        <button
                            type="submit"
                            className="w-12 h-12 flex items-center justify-center bg-amber-500 text-black rounded-2xl hover:scale-105 active:scale-95 transition-all shadow-lg"
                        >
                            ➤
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};

export default Lobby;
