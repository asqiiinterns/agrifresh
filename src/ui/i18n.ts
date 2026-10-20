// Interface languages. French is the source: every text shown through ui/Text is looked up here
// (exact text, case-insensitive) and replaced in English or Arabic; unknown texts stay in French.
export type Language = "fr" | "en" | "ar";
export const languages: { value: Language; label: string }[] = [
  { value: "fr", label: "Français" },
  { value: "en", label: "English" },
  { value: "ar", label: "العربية" },
];

// [français, english, العربية]
const entries: [string, string, string][] = [
  // Navigation
  ["Accueil", "Home", "الرئيسية"], ["À décider", "To decide", "قيد القرار"], ["Production", "Production", "الإنتاج"],
  ["Facturation", "Billing", "الفوترة"], ["Livraisons", "Deliveries", "التوصيل"], ["Plus", "More", "المزيد"],
  ["Messages", "Messages", "الرسائل"], ["Alertes", "Alerts", "التنبيهات"], ["Commander", "Order", "اطلب"],
  ["Commandes", "Orders", "الطلبيات"], ["Mes commandes", "My orders", "طلبياتي"], ["Mes factures", "My invoices", "فواتيري"],
  ["Factures", "Invoices", "الفواتير"], ["Clients", "Customers", "الحرفاء"], ["Planning", "Planning", "التخطيط"],
  ["Compte", "Account", "الحساب"], ["Admin", "Admin", "الإدارة"], ["Calendrier", "Calendar", "الرزنامة"],
  ["Congés", "Leave", "العطل"], ["Incidents", "Incidents", "الحوادث"], ["Statistiques", "Statistics", "الإحصائيات"],
  ["Retours et avoirs", "Returns & credit notes", "المرتجعات والإشعارات الدائنة"], ["Rubriques", "Sections", "الأقسام"],
  ["Personnaliser", "Customize", "تخصيص"], ["Affichage", "Display", "العرض"], ["Notifications", "Notifications", "الإشعارات"],
  ["Autorisations", "Permissions", "الأذونات"], ["Produits", "Products", "المنتجات"], ["Équipe", "Team", "الفريق"],
  ["Paramétrage", "Settings", "الإعدادات"], ["Comptes", "Accounts", "الحسابات"], ["Flotte", "Fleet", "الأسطول"],
  ["Journal des actions", "Activity log", "سجل العمليات"], ["Localisation", "Location", "الموقع"],
  ["Commandes récurrentes", "Recurring orders", "الطلبيات الدورية"],
  // Sheets & sections
  ["En cours", "In progress", "قيد الإنجاز"], ["Clôturées", "Closed", "مغلقة"], ["Réclamations", "Claims", "الشكاوى"],
  ["Avoirs", "Credit notes", "الإشعارات الدائنة"], ["Retours", "Returns", "المرتجعات"], ["Tableau de bord", "Dashboard", "لوحة القيادة"],
  ["À préparer", "To prepare", "للتحضير"], ["À récupérer", "To pick up", "للاستلام"], ["À livrer", "To deliver", "للتوصيل"],
  ["Historique", "History", "السجل"], ["Raccourcis", "Shortcuts", "اختصارات"], ["Mes demandes", "My requests", "طلباتي"],
  ["À valider", "To approve", "للمصادقة"], ["Signaler", "Report", "تبليغ"], ["Clôturés", "Closed", "مغلقة"],
  ["Favoris ★", "Favourites ★", "المفضلة ★"], ["Non lues", "Unread", "غير مقروءة"], ["Toutes", "All", "الكل"], ["Tous", "All", "الكل"],
  // Statuses
  ["Nouvelle", "New", "جديدة"], ["En attente", "On hold", "في الانتظار"], ["À reconfirmer", "To reconfirm", "للتأكيد من جديد"],
  ["Acceptée", "Accepted", "مقبولة"], ["En préparation", "Preparing", "قيد التحضير"], ["Préparée", "Ready", "جاهزة"],
  ["Expédiée", "Shipped", "مرسلة"], ["Livrée", "Delivered", "مسلّمة"], ["Déclinée", "Declined", "مرفوضة"], ["Annulée", "Cancelled", "ملغاة"],
  ["Reçue", "Received", "مستلمة"], ["En route", "On the way", "في الطريق"], ["Brouillon", "Draft", "مسودة"],
  ["À encaisser", "To collect", "للتحصيل"], ["Payée", "Paid", "مدفوعة"], ["En retard", "Overdue", "متأخرة"],
  ["Accepté", "Approved", "مقبول"], ["Refusé", "Refused", "مرفوض"], ["Annulé", "Cancelled", "ملغى"], ["Émis", "Issued", "صادر"],
  ["Remboursé", "Refunded", "مسترجع"], ["Déduit", "Deducted", "مخصوم"], ["Demandé", "Requested", "مطلوب"], ["Reçu", "Received", "مستلم"],
  // Buttons
  ["ENREGISTRER", "SAVE", "حفظ"], ["ANNULER", "CANCEL", "إلغاء"], ["VALIDER", "CONFIRM", "تأكيد"], ["ACCEPTER", "ACCEPT", "قبول"],
  ["REFUSER", "REFUSE", "رفض"], ["DÉCLINER", "DECLINE", "رفض"], ["METTRE EN ATTENTE", "PUT ON HOLD", "وضع في الانتظار"],
  ["SUPPRIMER", "DELETE", "حذف"], ["MODIFIER", "EDIT", "تعديل"], ["FERMER", "CLOSE", "إغلاق"], ["RETOUR", "BACK", "رجوع"],
  ["SE DÉCONNECTER", "SIGN OUT", "تسجيل الخروج"], ["ACTUALISER", "REFRESH", "تحديث"], ["RÉESSAYER", "RETRY", "إعادة المحاولة"],
  ["ENVOYER", "SEND", "إرسال"], ["ÉCRIRE", "WRITE", "اكتب"], ["SCANNER", "SCAN", "مسح"], ["EXPÉDIER", "SHIP", "إرسال"],
  ["PLANNING", "PLANNING", "التخطيط"], ["PLANIFIER", "PLAN", "تخطيط"], ["BON DE LIVRAISON", "DELIVERY NOTE", "وصل التسليم"],
  ["VOIR LA FACTURE", "VIEW INVOICE", "عرض الفاتورة"], ["+ FACTURER", "+ INVOICE", "+ فوترة"], ["+ NOUVEAU", "+ NEW", "+ جديد"],
  ["+ NOUVEAU MESSAGE", "+ NEW MESSAGE", "+ رسالة جديدة"], ["+ RAPPEL", "+ REMINDER", "+ تذكير"], ["+ DEMANDE", "+ REQUEST", "+ طلب"],
  ["+ RETOUR", "+ RETURN", "+ مرتجع"], ["+ AVOIR", "+ CREDIT NOTE", "+ إشعار دائن"], ["INCIDENT", "INCIDENT", "حادث"],
  ["TOUT LIRE", "MARK ALL READ", "قراءة الكل"], ["VOIR TOUTES", "SEE ALL", "عرض الكل"], ["AUTORISER", "ALLOW", "سماح"],
  ["RÉGLAGES", "SETTINGS", "الإعدادات"], ["PDF", "PDF", "PDF"], ["CARTE", "MAP", "خريطة"], ["CLÔTURER", "CLOSE", "إغلاق"],
  ["ENVOYER LES RELANCES", "SEND REMINDERS", "إرسال التذكيرات"], ["+ ENREGISTRER UN RÈGLEMENT", "+ RECORD A PAYMENT", "+ تسجيل دفعة"],
  ["COMMENCER LA PRÉPARATION", "START PREPARING", "بدء التحضير"], ["MARQUER PRÊTE", "MARK READY", "تحديد كجاهزة"],
  ["MARQUER PRÉPARÉE", "MARK READY", "تحديد كجاهزة"], ["DEMANDER UN RETOUR", "REQUEST A RETURN", "طلب إرجاع"],
  ["SIGNALER UN PROBLÈME", "REPORT A PROBLEM", "الإبلاغ عن مشكلة"], ["RECONFIRMER", "RECONFIRM", "إعادة التأكيد"],
  ["RÉPÉTER AUTOMATIQUEMENT", "REPEAT AUTOMATICALLY", "تكرار تلقائي"], ["FAIRE SIGNER", "GET SIGNATURE", "طلب التوقيع"],
  ["CONFIRMER LA REMISE", "CONFIRM HAND-OVER", "تأكيد التسليم"], ["EXPORTER", "EXPORT", "تصدير"],
  // Common labels
  ["Bonjour", "Hello", "مرحبا"], ["Bonsoir", "Good evening", "مساء الخير"], ["Chargement…", "Loading…", "جار التحميل…"],
  ["Rechercher un client", "Search a customer", "ابحث عن حريف"], ["Votre message…", "Your message…", "رسالتك…"],
  ["Filtres", "Filters", "التصفية"], ["Livraison", "Delivery", "التوصيل"], ["Statut", "Status", "الحالة"], ["Date", "Date", "التاريخ"],
  ["Aujourd’hui", "Today", "اليوم"], ["Demain", "Tomorrow", "غدا"], ["Hier", "Yesterday", "أمس"], ["7 derniers jours", "Last 7 days", "آخر 7 أيام"],
  ["30 derniers jours", "Last 30 days", "آخر 30 يوما"], ["Ce mois-ci", "This month", "هذا الشهر"], ["Mois dernier", "Last month", "الشهر الماضي"],
  ["Commandes du", "Orders of", "طلبيات يوم"], ["Émise le", "Issued on", "صدرت في"], ["Réglée le", "Paid on", "دفعت في"],
  ["Trier par", "Sort by", "ترتيب حسب"], ["Total HT", "Total excl. VAT", "المجموع دون أداءات"], ["Net à payer TTC", "Total due incl. VAT", "الصافي للدفع"],
  ["Timbre fiscal", "Stamp duty", "الطابع الجبائي"], ["Règlements", "Payments", "الدفعات"], ["Mode de règlement", "Payment method", "طريقة الدفع"],
  ["Virement", "Transfer", "تحويل"], ["Chèque", "Cheque", "صك"], ["Espèces", "Cash", "نقدا"], ["Carte", "Card", "بطاقة"], ["Autre", "Other", "أخرى"],
  ["Nécessite une réponse", "Needs a reply", "يحتاج إلى رد"], ["Réponse attendue", "Reply expected", "في انتظار الرد"],
  ["Photo / vidéo", "Photo / video", "صورة / فيديو"], ["Galerie", "Gallery", "المعرض"], ["Document", "Document", "وثيقة"], ["Vocal", "Voice", "صوتي"],
  ["Message vocal", "Voice message", "رسالة صوتية"], ["Suivi spécial", "Special follow-up", "متابعة خاصة"], ["À reprogrammer", "To reschedule", "لإعادة البرمجة"],
  ["Mot de passe", "Password", "كلمة المرور"], ["Taille du texte", "Text size", "حجم النص"], ["Langue", "Language", "اللغة"],
  ["Petite", "Small", "صغير"], ["Normale", "Normal", "عادي"], ["Grande", "Large", "كبير"], ["Très grande", "Very large", "كبير جدا"],
  ["Mon accueil", "My home", "صفحتي الرئيسية"], ["Profil", "Profile", "الملف الشخصي"], ["Rien en suspens", "Nothing pending", "لا شيء معلق"],
  ["Aucune commande", "No orders", "لا توجد طلبيات"], ["Aucune alerte", "No alerts", "لا توجد تنبيهات"], ["Aucun message", "No messages", "لا توجد رسائل"],
  ["Aucune facture", "No invoices", "لا توجد فواتير"], ["Rien à récupérer", "Nothing to pick up", "لا شيء للاستلام"], ["Aucune livraison", "No deliveries", "لا يوجد توصيل"],
  ["Commandes à décider", "Orders to decide", "طلبيات للقرار"], ["Commandes du jour", "Today's orders", "طلبيات اليوم"],
  ["En file de production", "In production queue", "في قائمة الإنتاج"], ["Prêtes à expédier", "Ready to ship", "جاهزة للإرسال"],
  ["En livraison", "Out for delivery", "قيد التوصيل"], ["Messages non lus", "Unread messages", "رسائل غير مقروءة"], ["Alertes non lues", "Unread alerts", "تنبيهات غير مقروءة"],
  ["Comptes à valider", "Accounts to approve", "حسابات للمصادقة"], ["Retours à traiter", "Returns to handle", "مرتجعات للمعالجة"],
  ["Facturé ce mois", "Invoiced this month", "المفوتر هذا الشهر"], ["Encaissé ce mois", "Collected this month", "المحصل هذا الشهر"],
  ["Reste à encaisser", "Still to collect", "المتبقي للتحصيل"], ["Commandes en cours", "Orders in progress", "طلبيات قيد الإنجاز"],
  ["Factures à régler", "Invoices to pay", "فواتير للدفع"], ["Passer une commande", "Place an order", "تقديم طلبية"],
  ["Écrire à AgriFresh", "Write to AgriFresh", "راسل AgriFresh"], ["Mon compte", "My account", "حسابي"],
  ["Votre panier", "Your cart", "سلتك"], ["Quantité", "Quantity", "الكمية"], ["Prix", "Price", "السعر"], ["Origine", "Origin", "المصدر"],
  ["Point de livraison", "Delivery point", "نقطة التوصيل"], ["Date de livraison souhaitée", "Requested delivery date", "تاريخ التوصيل المطلوب"],
  ["Remarque", "Note", "ملاحظة"], ["Nouveau", "New", "جديد"], ["Stock", "Stock", "المخزون"], ["Lundi", "Monday", "الإثنين"], ["Mardi", "Tuesday", "الثلاثاء"],
  ["Mercredi", "Wednesday", "الأربعاء"], ["Jeudi", "Thursday", "الخميس"], ["Vendredi", "Friday", "الجمعة"], ["Samedi", "Saturday", "السبت"], ["Dimanche", "Sunday", "الأحد"],
  ["Signature du client", "Customer signature", "توقيع الحريف"], ["Nom du signataire", "Signer's name", "اسم الموقع"], ["Effacer", "Clear", "مسح"],
  ["Hors ligne", "Offline", "غير متصل"], ["Exports", "Exports", "التصدير"],
];

const maps: Record<Exclude<Language, "fr">, Map<string, string>> = { en: new Map(), ar: new Map() };
for (const [fr, en, ar] of entries) {
  const key = fr.toLocaleLowerCase("fr");
  maps.en.set(key, en);
  maps.ar.set(key, ar);
}

export function translate(text: string, language: Language): string {
  if (language === "fr" || !text) return text;
  const trimmed = text.trim();
  const found = maps[language].get(trimmed.toLocaleLowerCase("fr"));
  if (!found) return text;
  // Keep upper case for button labels, and the original surrounding spaces.
  const value = language === "en" && trimmed === trimmed.toLocaleUpperCase("fr") && /[A-ZÀ-Ý]/.test(trimmed) ? found.toLocaleUpperCase("en") : found;
  return text.replace(trimmed, value);
}
