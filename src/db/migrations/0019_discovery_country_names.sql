-- 0019_discovery_country_names: more ways the seeded countries and cities are
-- written, so a persona term carrying any of them is cleaned. A city's extra
-- spellings sit under `alt`; searches use only `en` and `ar`.
update marketing.rules set document = '{"if": [true, {
     "gl": "sa",
     "languages": ["ar", "en"],
     "suffix": {"en": "Saudi Arabia", "ar": "السعودية"},
     "names": ["saudi", "saudi arabia", "ksa", "kingdom of saudi arabia", "السعودية", "المملكة العربية السعودية", "المملكة"],
     "cities": [
       {"en": "Riyadh", "ar": "الرياض", "alt": "riyad"}, {"en": "Jeddah", "ar": "جدة", "alt": "jedda"},
       {"en": "Dammam", "ar": "الدمام"}, {"en": "Mecca", "ar": "مكة", "alt": "makkah"},
       {"en": "Medina", "ar": "المدينة المنورة", "alt": "madinah"}, {"en": "Khobar", "ar": "الخبر", "alt": "al khobar"},
       {"en": "Jubail", "ar": "الجبيل", "alt": "al jubail"}, {"en": "Yanbu", "ar": "ينبع"}, {"en": "Tabuk", "ar": "تبوك"},
       {"en": "Abha", "ar": "أبها"}, {"en": "Dhahran", "ar": "الظهران"}, {"en": "Qassim", "ar": "القصيم", "alt": "buraidah"}
     ]}, null]}'::jsonb
where kind = 'discovery.country' and scope = 'region' and region = 'SA';

update marketing.rules set document = '{"if": [true, {
     "gl": "ae",
     "languages": ["en", "ar"],
     "suffix": {"en": "UAE", "ar": "الإمارات"},
     "names": ["uae", "u.a.e", "emirates", "united arab emirates", "الإمارات", "الامارات", "الإمارات العربية المتحدة"],
     "cities": [
       {"en": "Dubai", "ar": "دبي"}, {"en": "Abu Dhabi", "ar": "أبوظبي", "alt": "ابو ظبي"},
       {"en": "Sharjah", "ar": "الشارقة"}, {"en": "Ajman", "ar": "عجمان"}, {"en": "Al Ain", "ar": "العين"},
       {"en": "Ras Al Khaimah", "ar": "رأس الخيمة", "alt": "rak"}, {"en": "Fujairah", "ar": "الفجيرة"}
     ]}, null]}'::jsonb
where kind = 'discovery.country' and scope = 'region' and region = 'AE';
