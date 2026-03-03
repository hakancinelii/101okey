// src/i18n.ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import translationEN from './locales/en/translation.json';
import translationTR from './locales/tr/translation.json';

i18n
    .use(LanguageDetector) // detect user language
    .use(initReactI18next) // pass i18n to react-i18next
    .init({
        resources: {
            en: { translation: translationEN },
            tr: { translation: translationTR },
        },
        fallbackLng: 'en',
        interpolation: { escapeValue: false },
    });

export default i18n;
