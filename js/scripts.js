// The call scripts, written as data so the runner can present them and the
// answers can be reported on later. `say` lines are read aloud; `fields`
// are what gets written down. A field with `showIf` only appears once the
// answer it depends on makes it relevant.

export const SALES_SCRIPT = {
  id: 'sales',
  title: 'שיחת מכירה – ליד חדש',
  // Anyone who has not paid for a trial week yet goes through this.
  stages: ['new', 'contacted', 'pitched'],
  sections: [
    {
      id: 'greeting',
      title: 'ברכה',
      say: [
        'היי [שם]?',
        'היי, זה [שם הנציג] מ-Ribak, אני מתקשר כי אני רואה שרצית לשמוע עוד על הארוחות המוכנות שלנו?',
        'אחלה, כדי שאוכל לראות האם אנחנו יכולים לעזור לך, אשמח לשאול אותך כמה שאלות, זה בסדר?',
      ],
      fields: [],
    },
    {
      id: 'discovery',
      title: 'בירור צרכים',
      note: 'זה החלק שמייצר את כל המידע. מה שתכתוב כאן יופיע לך בשיחת ההמרה ביום שלישי.',
      say: ['אז אשמח לשמוע…'],
      fields: [
        { id: 'why', type: 'textarea', ask: 'מה הסיבה שאתה מתעניין בהזמנת ארוחות מוכנות?', hint: 'זו המטרה שלו – תשקף לו אותה בהמשך השיחה וגם ביום שלישי', rows: 2, key: true },
        { id: 'current', type: 'choice', ask: 'מה אתה אוכל עכשיו? מבשל בבית? מזמין בוולט?',
          options: ['מבשל בבית', 'משלוחים / וולט', 'מסעדות', 'אוכל מוכן אחר', 'לא מסודר בכלל'] },
        { id: 'tried', type: 'choice', ask: 'האם אי פעם התעניינת בדבר דומה?', options: ['כן', 'לא'] },
        { id: 'ordered', type: 'choice', ask: 'והזמנת בפועל?', options: ['כן', 'לא'], showIf: { tried: 'כן' } },
        { id: 'experience', type: 'textarea', ask: 'איך הייתה החוויה שלך? למה הפסקת?', rows: 2, showIf: { ordered: 'כן' } },
        { id: 'blocker', type: 'textarea', ask: 'מה עצר אותך מלעשות את זה בפעם שעברה?', rows: 2, showIf: { ordered: 'לא' } },
        { id: 'whyNow', type: 'textarea', ask: 'מה גורם לך להתעניין בזה דווקא עכשיו?', rows: 2, showIf: { tried: 'לא' } },
        { id: 'meals', type: 'number', ask: 'כמה ארוחות חמות היית רוצה להזמין בשבוע?', placeholder: '5' },
        { id: 'dislikes', type: 'text', ask: 'האם יש משהו שאתה לא אוהב לאכול בכלל? אלרגי?', placeholder: 'לא אוכל דגים / אלרגי לאגוזים' },
        { id: 'city', type: 'text', ask: 'מאיפה אתה בארץ?', hint: 'אנחנו מגיעים מאשדוד עד נתניה', placeholder: 'רעננה', key: true },
      ],
    },
    {
      id: 'pitch',
      title: 'פרזנטציה',
      say: [
        'אחלה מעולה. קודם כל אני רוצה להגיד תודה על שיתוף הפעולה. אני חושב שאנחנו מאוד מתאימים ואני אגיד לך למה.',
        'ממה שהבנתי ממך, {why} – נכון?',
        'אז תראה. מה שאני מציע, זה שנלמד להכיר אחד את השני. אני רוצה שתרגיש, תראה, תטעם ותחליט בעצמך שאתה רוצה להמשיך באופן קבוע – ולכן הייתי רוצה שנתחיל בשבוע הראשון.',
        'אני ניב, שף פרטי, בן 26. לפני 3 שנים הקמתי את ריבאק במטרה לעזור לאנשים לשמור על התזונה שלהם, תוך כדי שהם אוכלים אוכל טעים ובריא שיתן להם חשק להמשיך.',
        'המשימה של "לדאוג שיהיה לי אוכל בריא בבית" לוקחת זמן, מאמץ וחשיבה – ומפה השירות שלנו נולד. במקום שכל שבוע יהיה חור שחור של תכנון, כל שבוע נפתח בזה שהמקרר שלך מלא במנות מזינות, בריאות וטעימות שיעזרו לך לעמוד במטרות שלך.',
        'המשלוח שלנו מגיע בימי ראשון, בין 07:00 ל-10:00 בבוקר, ובו תקבל את האוכל של כל השבוע.',
        'הרבה שואלים אותי בנקודה הזו איך האוכל מחזיק לכל השבוע, וזאת שאלה מעולה. התוקף הרשמי הוא 36 שעות מיום הקבלה – אבל בפועל המנות נשמרות מעולה עד 5 ימים, וזה לא במקרה. מיד אחרי הבישול כל מנה עוברת Blast Chilling – קירור מהיר מ-70° ל-4° בתוך פחות משעה. במקרר ביתי זה לוקח 24-32 שעות.',
        'יש לך שאלות עד לכאן?',
      ],
      fields: [
        { id: 'questions', type: 'textarea', ask: 'מה הוא שאל?', hint: 'התנגדויות שחוזרות כאן שוות זהב', rows: 2 },
      ],
    },
    {
      id: 'close',
      title: 'סגירה',
      say: [
        'לפני שנבחר את המנות, אני רוצה לתת לך הטבה ממני. מנויים קבועים מקבלים 5% הנחה להזמנה השבועית, אבל בגלל שאנחנו מדברים בטלפון אני אתן לך 10% הנחה על ההזמנה הראשונה שנבצע עכשיו.',
        'ההזמנה לשבוע שאחרי לא תישלח באופן קבוע. אני אחייג אליך בהמשך השבוע, אחרי שכבר טעמת את המנות, ונחליט ביחד אם אתה רוצה להמשיך ואיך תיראה ההזמנה הבאה שלך.',
        'אתה מוכן לעשות את ההזמנה של השבוע הראשון?',
      ],
      fields: [
        { id: 'protein', type: 'choice', ask: 'עוף / בקר / דגים? הכל אותו סוג או לגוון?',
          options: ['עוף', 'בקר', 'דגים', 'מגוון'] },
        { id: 'dishes', type: 'number', ask: 'כמה מנות בשבוע הראשון?', placeholder: '5' },
        { id: 'changes', type: 'text', ask: 'רצה לשנות מנה כלשהי?', placeholder: 'החליף את הסלמון' },
      ],
      closing: true,
    },
  ],
};

export const SCRIPTS = { sales: SALES_SCRIPT };

export const fieldsOf = script => script.sections.flatMap(s => s.fields);

// A field is live only when every condition on it is met by what was
// already answered.
export const isVisible = (field, answers) =>
  !field.showIf || Object.entries(field.showIf).every(([k, v]) => answers[k] === v);

export const visibleFields = (script, answers) => fieldsOf(script).filter(f => isVisible(f, answers));

export const answeredCount = (script, answers) =>
  visibleFields(script, answers).filter(f => String(answers[f.id] ?? '').trim() !== '').length;

// Ribak delivers between Ashdod and Netanya; anything else is a
// disqualification worth catching before the pitch, not after.
const OUT_OF_AREA = /חיפה|כרמיאל|צפת|טבריה|נהריה|עכו|קריות|עפולה|באר\s*שבע|אילת|דימונה|ערד|אשקלון|שדרות|נתיבות|אופקים|מצפה\s*רמון|קצרין|גולן|כנרת|נצרת|מגדל\s*העמק|בית\s*שאן|קרית\s*שמונה/;
export const cityOutOfArea = city => OUT_OF_AREA.test(String(city || ''));
