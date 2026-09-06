import zhCN from "./locales/zh-CN.js";

const LOCALES = { "zh-CN": zhCN };
let currentLocale = "zh-CN";
let dict = LOCALES[currentLocale];

// Look up a translated string. Falls back to the raw key when missing.
export function t(key, params) {
  let s = dict[key] ?? key;
  if (params) {
    for (const k of Object.keys(params)) {
      s = s.split(`{${k}}`).join(String(params[k]));
    }
  }
  return s;
}

export function getLocale() {
  return currentLocale;
}

export function hasLocale(locale) {
  return !!LOCALES[locale];
}

export function setLocale(locale) {
  if (LOCALES[locale]) {
    currentLocale = locale;
    dict = LOCALES[locale];
  }
  applyDataI18n();
  document.documentElement.lang = currentLocale;
}

// Fill every [data-i18n] / [data-i18n-title] / [data-i18n-placeholder]
// element from the dictionary. HTML keeps the default (zh-CN) text so the
// page renders without JS too.
export function applyDataI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    el.alt = t(el.getAttribute("data-i18n-alt"));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
  document.title = t("app.title");
}

// Pick locale from ?lang= URL param (highest priority) or localStorage.
export function initI18n() {
  const urlLang = new URLSearchParams(location.search).get("lang");
  const saved = localStorage.getItem("lang");
  if (urlLang) setLocale(urlLang);
  else if (saved) setLocale(saved);
  else setLocale("zh-CN");
}
