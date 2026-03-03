// src/components/PremiumToggle.tsx
import React, { useEffect, useState } from 'react';
import * as Switch from '@radix-ui/react-switch';
import { useTranslation } from 'react-i18next';

/**
 * Premium toggle component.
 * - Fetches current premiumEnabled flag from /api/config (any user can read).
 * - If the logged‑in user is admin (role stored in JWT), allows toggling via POST.
 * - Uses Radix UI Switch for a polished look.
 */
const PremiumToggle: React.FC = () => {
    const { t } = useTranslation();
    const [enabled, setEnabled] = useState(false);
    const [isAdmin, setIsAdmin] = useState(false);
    const [loading, setLoading] = useState(true);

    // Helper to extract role from JWT (simple base64 decode, no verification here)
    const getUserRole = () => {
        const token = localStorage.getItem('token');
        if (!token) return null;
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            return payload.role;
        } catch (e) {
            return null;
        }
    };

    useEffect(() => {
        // Fetch config
        const fetchConfig = async () => {
            try {
                const res = await fetch('/api/config');
                const data = await res.json();
                setEnabled(data.premiumEnabled);
                const role = getUserRole();
                setIsAdmin(role === 'ADMIN');
            } catch (e) {
                console.error('Failed to fetch config', e);
            } finally {
                setLoading(false);
            }
        };
        fetchConfig();
    }, []);

    const toggle = async () => {
        if (!isAdmin) return; // non‑admin cannot change
        const newValue = !enabled;
        try {
            const token = localStorage.getItem('token') || '';
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ premiumEnabled: newValue }),
            });
            if (res.ok) {
                setEnabled(newValue);
            } else {
                console.error('Failed to update config');
            }
        } catch (e) {
            console.error('Error updating config', e);
        }
    };

    if (loading) return <div>{t('loading')}...</div>;

    return (
        <div className="flex items-center space-x-2">
            <label className="text-sm font-medium" htmlFor="premium-switch">
                {t('premiumToggle')}
            </label>
            <Switch.Root
                id="premium-switch"
                checked={enabled}
                disabled={!isAdmin}
                onCheckedChange={toggle}
                className="w-10 h-5 bg-gray-300 rounded-full relative data-[state=checked]:bg-primary transition-colors"
            >
                <Switch.Thumb className="block w-4 h-4 bg-white rounded-full shadow transition-transform translate-x-0 data-[state=checked]:translate-x-5" />
            </Switch.Root>
        </div>
    );
};

export default PremiumToggle;
