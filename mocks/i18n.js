// Externalised UI strings and locale-aware formatting for the v3 mocks.
//
// Only Sendproof's own chrome is translated. Text that comes from the OpenAPI document
// (operation summaries, field titles, descriptions) is shown as the API author wrote it and
// is marked with lang="en", so screen readers switch voice (WCAG 3.1.2 Language of Parts).
//
// ?lang=en|de|ar picks the catalogue (v5 adds ja and he for its i18n screens). ?platform=mac|win picks the shortcut glyphs.
// ?digits=arab shows Arabic-Indic digits; Arabic uses Latin digits by default (owner decision).
(function () {
  const params = new URLSearchParams(location.search);
  const lang = params.get('lang') || 'en';
  const platform = params.get('platform') || (lang === 'de' ? 'win' : 'mac');
  const digits = params.get('digits') === 'arab' ? 'arab' : 'latn';

  const catalogues = {
    en: {
      // Run-button widths in em: the widest density plus room for the keycap, per platform.
      locale: 'en-IE', dir: 'ltr', widths: { mac: { preview: '11.5em', send: '11em' }, win: { preview: '12.75em', send: '12.5em' } },
      'm.request': 'Request', 'm.result': 'Result', 'send.real': 'Send for real', 'open.order': 'Open order', 'copy.curl': 'Copy as cURL',
      'in.days': 'In {n} days · no Sunday delivery',
      'search': 'Search or run a command…', 'signIn': 'Sign in', 'display': 'Display settings',
      'env': 'Development', 'operations': 'Operations', 'models': 'Models', 'filter.ops': 'Filter operations', 'filter.models': 'Filter models',
      'view.try': 'Try it', 'view.docs': 'Docs',
      // v4: navigation, reference pages, property tree, JSON viewer and the bottom bars.
      'browse': 'Browse', 'crumbs': 'Breadcrumbs', 'view.label': 'Operation view', 'back': 'Back', 'back.to': 'Back to {name}',
      'nav.deprecated': 'Deprecated', 'nav.locked': 'Needs sign-in', 'nav.roles': 'Needs {roles}',
      'auth.out.title': 'You’re signed out', 'auth.out.body': '{n} of {total} operations need sign-in. They’re marked with a lock.', 'auth.out.seeded': 'Seeded account',
      'foot.ops': { one: '{n} operation', other: '{n} operations' }, 'foot.models': { one: '{n} schema', other: '{n} schemas' }, 'foot.collapseAll': 'Collapse all', 'foot.expandAll': 'Expand all',
      'expandAll': 'Expand all', 'collapseAll': 'Collapse all',
      'models.resources': 'Resources', 'models.requests': 'Request bodies', 'models.enums': 'Enums', 'models.errors': 'Errors', 'models.lists': 'List pages',
      'models.count': { one: '{n} model', other: '{n} models' },
      'kind.object': 'Object', 'kind.enum': 'Enum', 'kind.oneOf': 'One of several types', 'kind.allOf': 'All of several types', 'kind.array': 'Array',
      'kind.objectN': { one: 'object · {n} property', other: 'object · {n} properties' }, 'kind.enumN': { one: 'enum · {n} value', other: 'enum · {n} values' },
      'kind.oneOfN': 'one of {n} types',
      'schema.required': 'required', 'schema.noDesc': 'No description in the spec', 'schema.noDescModel': 'This model has no description in the spec.',
      'schema.seeModel': 'Described on the {name} model', 'schema.values': 'Values', 'schema.example': 'Example', 'schema.more': '+{n} more',
      'schema.expand': 'Expand {name}', 'schema.collapse': 'Collapse {name}', 'schema.openModel': 'Open the {name} model', 'schema.recursive': 'recursive',
      'schema.oneOf': 'one of {n}', 'schema.oneOfHead': 'One of {n} types', 'schema.chosenBy': 'Chosen by', 'schema.variant': 'Variant',
      'schema.whenValue': 'When <code>{prop}</code> is <code>"{value}"</code>, the object is a {name}.', 'schema.treeLabel': '{name} properties',
      'chip.format': 'format', 'chip.min': 'min', 'chip.gt': 'more than', 'chip.max': 'max', 'chip.step': 'step', 'chip.length': 'length', 'chip.minLength': 'min length',
      'chip.maxLength': 'max length', 'chip.pattern': 'pattern', 'chip.items': 'items', 'chip.unique': 'unique items', 'chip.default': 'default',
      'chip.readOnly': 'read-only', 'chip.writeOnly': 'write-only', 'chip.nullable': 'nullable', 'chip.deprecated': 'deprecated',
      'used.request': 'request body', 'used.response': 'response {code}', 'used.via': 'via {name}', 'used.viaHead': 'No operation uses it directly. Through the models that contain it:',
      'json.keys': { one: '{n} key', other: '{n} keys' }, 'json.items': { one: '{n} item', other: '{n} items' }, 'json.lines': { one: '{n} line', other: '{n} lines' },
      'json.large': 'Large response ({size}, about {n} lines), so objects below the second level start collapsed.',
      'docs.body': 'Body', 'docs.props': { one: '{n} property', other: '{n} properties' }, 'docs.required': '{n} required', 'docs.bodyView': 'Body view',
      'docs.schema': 'Schema', 'docs.example': 'Example', 'docs.noBody': 'No body', 'docs.signin': 'Sign-in', 'docs.youreOut': 'You’re signed out',
      'docs.roles': 'Role', 'docs.rolesBody': { one: 'Signed-in users without this role get 403.', other: 'Any one of these roles is enough. Signed-in users without one get 403.' },
      'docs.public': 'Public: no sign-in needed.', 'docs.needsSignin': 'Needs sign-in', 'docs.signedIn': 'Signed-in users', 'docs.publicTag': 'Public',
      'docs.deprecated': 'Deprecated.', 'docs.noDesc': 'This operation has no description in the spec.', 'docs.request': 'Request',
      'docs.in.path': 'Path parameters', 'docs.in.query': 'Query parameters', 'docs.in.header': 'Headers', 'docs.in.cookie': 'Cookies',
      'docs.noInput': 'This operation takes no parameters and no body.', 'docs.responses': 'Responses', 'docs.documented': '{n} documented', 'docs.auth': 'Authentication',
      'docs.bar': 'Try it opens this operation with the documented example filled in', 'docs.aside': 'Outline and samples', 'docs.onPage': 'On this page',
      'docs.overview': 'Overview', 'docs.requestSample': 'Request sample', 'docs.responseSample': 'Response example', 'docs.language': 'Language',
      'docs.copySample': 'Copy sample', 'docs.base': 'Base URL', 'docs.copyBase': 'Copy base URL',
      'model.values': 'Values', 'model.discriminator': 'Discriminator', 'model.discBy': 'property', 'model.variants': 'Variants', 'model.exactlyOne': 'exactly one of {n}',
      'model.open': 'Open {name}', 'model.includes': 'Includes every property of', 'model.properties': 'Properties',
      'model.nested': { one: '{n} property has nested fields', other: '{n} properties have nested fields' }, 'model.valuesUndescribed': 'The spec lists these values without descriptions.',
      'model.flat': 'No nested properties', 'model.copyRef': 'Copy $ref', 'model.bar': 'Models come from components.schemas', 'model.copySchema': 'Copy JSON Schema',
      'model.aside': 'Usage and example', 'model.usedBy': 'Used by', 'model.unused': 'No operation uses this model directly.', 'model.referencedBy': 'Referenced by',
      'model.show': 'Show', 'model.jsonSchema': 'JSON Schema', 'model.copyExample': 'Copy example', 'model.schemaNote': 'As written in components.schemas',
      'model.exampleReal': 'A real record from the demo database', 'model.exampleNote': 'Built from the schema’s examples, enums and formats',
      'bar.noRuns': 'No runs yet for this operation', 'bar.runningShort': 'Running…', 'bar.noResponse': 'No response · nothing was saved',
      'bar.lastRun': '{what} at {time} as Ada Admin', 'bar.previewRun': 'Previewed', 'bar.sendRun': 'Sent', 'bar.sendTraced': 'Sent and traced',
      'ov.title': 'Overview', 'ov.how': 'How Sendproof works', 'ov.byTag': 'Operations by tag', 'ov.start': 'Start here', 'ov.signedIn': 'Signed in as Ada Admin',
      'ov.signedInBody': 'Requests run as Ada Admin with the admin role.', 'ov.readOnly': 'read-only', 'ov.tryPreview': 'try Preview', 'ov.shortcuts': 'All shortcuts',
      'ov.bar': 'Pick an operation in the sidebar, or search for one', 'ov.find': 'Find an operation',
      'ov.preview': 'Runs the request for real inside a transaction, shows every row, email and log it caused, then rolls back.',
      'ov.send': 'Runs it for real and commits, exactly like any other client.', 'ov.autofill': 'Fills fields from the schema, with real IDs from the API’s own list endpoints.',
      'tab.body': 'Body', 'tab.params': 'Params', 'tab.headers': 'Headers', 'tab.auth': 'Auth', 'tab.code': 'Code',
      'form': 'Form', 'json': 'JSON', 'autofill': 'Autofill', 'optional': 'optional', 'add': 'Add',
      'section.body': 'Body', 'required.note': 'Fields are required unless marked optional',
      'preview': 'Preview', 'send': 'Send', 'cancel': 'Cancel',
      'bar.rule': 'Preview rolls back · Send commits',
      'bar.running': 'Previewing as Ada Admin · you can keep editing',
      'res.response': 'Response', 'res.database': 'Database', 'res.effects': 'Side effects', 'res.logs': 'Logs', 'res.headers': 'Headers',
      'res.none': 'No result yet', 'history': 'History',
      'res.preview': 'Preview', 'res.sent': 'Sent', 'res.traced': 'Sent · traced',
      'committed.title': 'Committed.', 'committed.body': 'Traced Send recorded the rows this request wrote to {db} as Ada Admin.',
      'email.sent': { one: '{n} email sent', other: '{n} emails sent' },
      'rolled.title': 'Rolled back. Nothing was saved.',
      'rolled.body': 'These are the rows this request would write to {db} as Ada Admin.',
      'rows': { one: '{n} row', other: '{n} rows' },
      'changes': { one: '{n} change', other: '{n} changes' },
      'ops': { one: '{n} operation', other: '{n} operations' },
      'more.cols': { one: '{n} more column', other: '{n} more columns' },
      'email.held': { one: '{n} email held back', other: '{n} emails held back' },
      'view': 'View', 'from.get': 'From {src} · sends {id}', 'list.lines': 'One instruction per line.', 'available': 'Catalog price: {amount}', 'business.days': 'No Sunday delivery for Standard.',
      'pick.copy': 'Copy URL',
    },
    de: {
      locale: 'de-DE', dir: 'ltr', widths: { mac: { preview: '12em', send: '12.25em' }, win: { preview: '13.5em', send: '13.5em' } },
      'm.request': 'Anfrage', 'm.result': 'Ergebnis', 'send.real': 'Wirklich senden', 'open.order': 'Bestellung öffnen', 'copy.curl': 'Als cURL kopieren',
      'in.days': 'In {n} Tagen · keine Sonntagszustellung',
      'search': 'Suchen oder Befehl …', 'signIn': 'Anmelden', 'display': 'Anzeigeeinstellungen',
      'env': 'Entwicklung', 'operations': 'Operationen', 'models': 'Modelle', 'filter.ops': 'Operationen filtern', 'filter.models': 'Modelle filtern',
      'view.try': 'Ausprobieren', 'view.docs': 'Dokumentation',
      'browse': 'Durchsuchen', 'crumbs': 'Brotkrumen', 'view.label': 'Ansicht der Operation', 'back': 'Zurück', 'back.to': 'Zurück zu {name}',
      'nav.deprecated': 'Veraltet', 'nav.locked': 'Anmeldung nötig', 'nav.roles': 'Benötigt {roles}',
      'auth.out.title': 'Sie sind abgemeldet', 'auth.out.body': '{n} von {total} Operationen brauchen eine Anmeldung. Sie sind mit einem Schloss markiert.', 'auth.out.seeded': 'Testkonto',
      'foot.ops': { one: '{n} Operation', other: '{n} Operationen' }, 'foot.models': { one: '{n} Schema', other: '{n} Schemas' }, 'foot.collapseAll': 'Alle einklappen', 'foot.expandAll': 'Alle ausklappen',
      'expandAll': 'Alle ausklappen', 'collapseAll': 'Alle einklappen', 'schema.required': 'Pflicht', 'schema.noDesc': 'Keine Beschreibung in der Spezifikation',
      'docs.onPage': 'Auf dieser Seite', 'docs.request': 'Anfrage', 'docs.responses': 'Antworten', 'docs.auth': 'Authentifizierung', 'docs.body': 'Body',
      'docs.bar': '„Ausprobieren“ öffnet diese Operation mit dem dokumentierten Beispiel', 'docs.base': 'Basis-URL', 'model.usedBy': 'Verwendet von',
      'bar.noRuns': 'Noch keine Ausführung für diese Operation', 'bar.lastRun': '{what} um {time} als Ada Admin', 'bar.previewRun': 'Vorschau', 'bar.sendRun': 'Gesendet', 'bar.sendTraced': 'Gesendet und aufgezeichnet',
      'tab.body': 'Inhalt', 'tab.params': 'Parameter', 'tab.headers': 'Header', 'tab.auth': 'Zugriff', 'tab.code': 'Code',
      'form': 'Formular', 'json': 'JSON', 'autofill': 'Ausfüllen', 'optional': 'optional', 'add': 'Hinzufügen',
      'section.body': 'Inhalt', 'required.note': 'Pflichtfelder, sofern nicht als optional markiert',
      'preview': 'Vorschau', 'send': 'Senden', 'cancel': 'Abbrechen',
      'bar.rule': 'Vorschau rollt zurück · Senden speichert',
      'bar.running': 'Vorschau als Ada Admin · Bearbeiten bleibt möglich',
      'res.response': 'Antwort', 'res.database': 'Datenbank', 'res.effects': 'Nebeneffekte', 'res.logs': 'Logs', 'res.headers': 'Header',
      'res.none': 'Noch kein Ergebnis', 'history': 'Verlauf',
      'res.preview': 'Vorschau', 'res.sent': 'Gesendet', 'res.traced': 'Gesendet · protokolliert',
      'committed.title': 'Gespeichert.', 'committed.body': 'Protokolliertes Senden hat die Zeilen erfasst, die diese Anfrage als Ada Admin in {db} geschrieben hat.',
      'email.sent': { one: '{n} E-Mail gesendet', other: '{n} E-Mails gesendet' },
      'rolled.title': 'Zurückgerollt. Es wurde nichts gespeichert.',
      'rolled.body': 'Diese Zeilen würde die Anfrage als Ada Admin in {db} schreiben.',
      'rows': { one: '{n} Zeile', other: '{n} Zeilen' },
      'changes': { one: '{n} Änderung', other: '{n} Änderungen' },
      'more.cols': { one: '{n} weitere Spalte', other: '{n} weitere Spalten' },
      'email.held': { one: '{n} E-Mail zurückgehalten', other: '{n} E-Mails zurückgehalten' },
      'view': 'Anzeigen', 'from.get': 'Aus {src} · sendet {id}', 'list.lines': 'Eine Zeile pro Anweisung.', 'available': 'Katalogpreis: {amount}', 'business.days': 'Bei Standard keine Sonntagszustellung.',
      'pick.copy': 'URL kopieren',
    },
    ar: {
      locale: 'ar', dir: 'rtl', widths: { mac: { preview: '10em', send: '11em' }, win: { preview: '11.25em', send: '12em' } },
      'm.request': 'الطلب', 'm.result': 'النتيجة', 'send.real': 'إرسال فعلي', 'open.order': 'فتح الطلب', 'copy.curl': 'نسخ كـ cURL',
      'in.days': 'بعد {n} أيام · لا توصيل يوم الأحد',
      'search': 'ابحث أو نفّذ أمرًا…', 'signIn': 'تسجيل الدخول', 'display': 'إعدادات العرض',
      'env': 'التطوير', 'operations': 'العمليات', 'models': 'النماذج', 'filter.ops': 'تصفية العمليات', 'filter.models': 'تصفية النماذج',
      'view.try': 'تجربة', 'view.docs': 'التوثيق',
      'browse': 'تصفّح', 'crumbs': 'مسار التنقل', 'view.label': 'عرض العملية', 'back': 'رجوع', 'back.to': 'رجوع إلى {name}',
      'nav.deprecated': 'مهملة', 'nav.locked': 'تتطلب تسجيل الدخول', 'nav.roles': 'تتطلب {roles}',
      'auth.out.title': 'لم تسجّل الدخول', 'auth.out.body': '{n} من {total} عملية تتطلب تسجيل الدخول، وعليها علامة قفل.', 'auth.out.seeded': 'حساب تجريبي',
      'foot.ops': { one: '{n} عملية', other: '{n} عملية' }, 'foot.models': { one: '{n} مخطط', other: '{n} مخططًا' }, 'foot.collapseAll': 'طيّ الكل', 'foot.expandAll': 'توسيع الكل',
      'expandAll': 'توسيع الكل', 'collapseAll': 'طيّ الكل', 'schema.required': 'مطلوب', 'schema.noDesc': 'لا يوجد وصف في المواصفة',
      'docs.onPage': 'في هذه الصفحة', 'docs.request': 'الطلب', 'docs.responses': 'الاستجابات', 'docs.auth': 'المصادقة', 'docs.body': 'المحتوى',
      'docs.bar': '«جرّبها» تفتح هذه العملية مع المثال الموثّق', 'docs.base': 'عنوان URL الأساسي', 'model.usedBy': 'تستخدمه',
      'bar.noRuns': 'لم تُشغَّل هذه العملية بعد', 'bar.lastRun': '{what} في {time} باسم Ada Admin', 'bar.previewRun': 'معاينة', 'bar.sendRun': 'أُرسلت', 'bar.sendTraced': 'أُرسلت وتُتبّعت',
      'tab.body': 'المحتوى', 'tab.params': 'المعاملات', 'tab.headers': 'الترويسات', 'tab.auth': 'المصادقة', 'tab.code': 'الشيفرة',
      'form': 'نموذج', 'json': 'JSON', 'autofill': 'تعبئة تلقائية', 'optional': 'اختياري', 'add': 'إضافة',
      'section.body': 'المحتوى', 'required.note': 'الحقول مطلوبة ما لم تُعلَّم بأنها اختيارية',
      'preview': 'معاينة', 'send': 'إرسال', 'cancel': 'إلغاء',
      'bar.rule': 'المعاينة تتراجع عن التغييرات · الإرسال يحفظها',
      'bar.running': 'معاينة باسم Ada Admin · يمكنك متابعة التحرير',
      'res.response': 'الاستجابة', 'res.database': 'قاعدة البيانات', 'res.effects': 'الآثار الجانبية', 'res.logs': 'السجلات', 'res.headers': 'الترويسات',
      'res.none': 'لا توجد نتيجة بعد', 'history': 'السجل',
      'res.preview': 'معاينة', 'res.sent': 'أُرسل', 'res.traced': 'أُرسل · مع التتبع',
      'committed.title': 'تم الحفظ.', 'committed.body': 'سجّل الإرسال مع التتبع الصفوف التي كتبها هذا الطلب في {db} باسم Ada Admin.',
      'email.sent': { zero: 'لم تُرسل رسائل', one: 'أُرسلت رسالة واحدة', two: 'أُرسلت رسالتان', few: 'أُرسلت {n} رسائل', many: 'أُرسلت {n} رسالة', other: 'أُرسلت {n} رسالة' },
      'rolled.title': 'تم التراجع. لم يُحفظ أي شيء.',
      'rolled.body': 'هذه هي الصفوف التي سيكتبها هذا الطلب في {db} باسم Ada Admin.',
      // Arabic has six plural forms; Intl.PluralRules picks the right one.
      'rows': { zero: 'لا صفوف', one: 'صف واحد', two: 'صفّان', few: '{n} صفوف', many: '{n} صفًا', other: '{n} صف' },
      'changes': { zero: 'لا تغييرات', one: 'تغيير واحد', two: 'تغييران', few: '{n} تغييرات', many: '{n} تغييرًا', other: '{n} تغيير' },
      'more.cols': { zero: 'لا أعمدة أخرى', one: 'عمود آخر', two: 'عمودان آخران', few: '{n} أعمدة أخرى', many: '{n} عمودًا آخر', other: '{n} عمود آخر' },
      'email.held': { zero: 'لا رسائل محجوزة', one: 'رسالة بريد محجوزة', two: 'رسالتا بريد محجوزتان', few: '{n} رسائل محجوزة', many: '{n} رسالة محجوزة', other: '{n} رسالة محجوزة' },
      'view': 'عرض', 'from.get': 'من {src} · يرسل {id}', 'list.lines': 'سطر لكل تعليمة.', 'available': 'سعر الكتالوج: {amount}', 'business.days': 'لا توصيل يوم الأحد للشحن العادي.',
      'pick.copy': 'نسخ الرابط',
    },
  };

  /* ---------- v5 (?v5=1) ---------- */
  // Strings for the v5 controls, attribute list, response viewer and language picker. Only
  // English is complete; Japanese and Hebrew carry what the v5 i18n screens show (the full
  // translation happens at implementation). Missing keys fall back to English.
  Object.assign(catalogues.en, {
    'v5.required': 'Required', 'v5.optional': 'Optional', 'v5.showKids': 'Show child attributes', 'v5.hideKids': 'Hide child attributes',
    'v5.enumValues': 'Possible enum values', 'v5.moreValues': { one: 'Show {n} more value', other: 'Show {n} more values' },
    'v5.arrayOf': 'array of', 'v5.nullable': 'nullable', 'v5.oneOfN': 'one of {n}', 'v5.chosenBy': 'Chosen by {prop}', 'v5.exactlyOne': 'Exactly one of these',
    'v5.always': 'Always {value} in this variant', 'v5.undocumented': 'Not in the schema', 'v5.chars': { one: '{n} character', other: '{n} characters' },
    'v5.f.format': 'Format', 'v5.f.range': 'Range', 'v5.f.min': 'Minimum', 'v5.f.max': 'Maximum', 'v5.f.gt': 'More than', 'v5.f.step': 'Step', 'v5.f.exactly': 'Exactly',
    'v5.f.length': 'Length', 'v5.f.maxLength': 'Max length', 'v5.f.minLength': 'Min length', 'v5.f.pattern': 'Pattern', 'v5.f.items': 'Items', 'v5.f.unique': 'Unique items',
    'v5.f.default': 'Default', 'v5.f.readOnly': 'Read-only', 'v5.f.writeOnly': 'Write-only', 'v5.f.deprecated': 'Deprecated', 'v5.f.example': 'Example',
    'v5.mark.on': 'Returned', 'v5.mark.off': 'Documented, not returned', 'v5.mark.issue': 'Doesn’t match the schema',
    // Fields
    'v5.about': 'About {name}', 'v5.clear': 'Clear', 'v5.clearName': 'Clear {name}', 'v5.generate': 'Generate a value for {name}', 'v5.generated': 'Generated: {what}', 'v5.undo': 'Undo',
    'v5.any': 'Any', 'v5.choose': 'Choose a value…', 'v5.chooseAn': 'Choose {name}…', 'v5.notSent': 'Not sent while unset', 'v5.sendsValue': 'Sends {v}',
    'v5.between': '{min} to {max}', 'v5.atLeast': 'At least {min}', 'v5.defaultIs': 'Default {v}', 'v5.upTo': 'Up to {n} characters', 'v5.sends': 'Sends {id}',
    'v5.lookup.count': '{n} customers that {who} can see', 'v5.lookup.signedOut': 'Sign in to choose from the API’s customers', 'v5.inDays': 'In {n} days · no Sunday delivery', 'v5.businessDays': 'No Sunday delivery for Standard',
    'v5.currency': 'Currency', 'v5.addLine': 'Add line', 'v5.removeLine': 'Remove line {n}', 'v5.filled': 'Filled {n} fields', 'v5.gen.lookup': 'a real customer Ada Admin can see', 'v5.gen.enum': 'a random value',
    'v5.err.choose': 'Choose a status', 'v5.err.range': 'Use {min} to {max}', 'v5.err.min': 'Use {min} or more', 'v5.err.long': 'Use {n} characters or fewer ({now} now)', 'v5.err.lookup': 'Choose a customer, or paste its ID', 'v5.err.number': 'Enter a number, like 79.90',
    'v5.issues': { one: '{n} field needs attention', other: '{n} fields need attention' }, 'v5.sec.path': 'Path', 'v5.sec.filter': 'Filter', 'v5.sec.paging': 'Page and order',
    'v5.readOnly': 'GET is read-only: nothing to roll back, so there’s no Preview', 'v5.needsSignin': 'Needs sign-in.', 'v5.needsSigninBody': 'You’re signed out, so this call will return 401.',
    // Listbox
    'v5.unsetHint': 'Not sent, so nothing is filtered out', 'v5.searchN': 'Search {n} values', 'v5.matches': { one: '{n} match', other: '{n} matches' }, 'v5.noMatch': 'Nothing matches “{q}”',
    'v5.k.move': 'move', 'v5.k.choose': 'choose', 'v5.typed': 'Typed', 'v5.or': ' or ',
    'v5.lk.search': 'Search by name, email or ID', 'v5.lk.label': 'Customers', 'v5.lk.last': 'From the last response', 'v5.lk.all': 'Customers · {n}', 'v5.lk.paste': 'Paste an ID',
    'v5.lk.random': 'Use a random UUID', 'v5.lk.randomHint': 'No record has it, so the call returns 404', 'v5.lk.refresh': 'Load the customers again',
    'v5.lk.as': '· as {who}', 'v5.lk.metaLoading': '· loading…', 'v5.lk.metaError': '· failed ({code})', 'v5.lk.metaOut': '· needs sign-in', 'v5.close': 'Close',
    'v5.lk.loading': 'Loading customers…', 'v5.lk.emptyTitle': '{who} can’t see any customers', 'v5.lk.emptyBody': 'The list endpoint returned none. Register one, or paste an ID you know.',
    'v5.lk.errorTitle': 'Couldn’t load the customers', 'v5.lk.errorBody': '{src} returned {code}. You can still paste an ID.', 'v5.lk.retry': 'Try again',
    'v5.lk.outTitle': 'Sign in to list customers', 'v5.lk.outBody': 'The options come from the API, which needs a signed-in user. You can still paste an ID.',
    // Deprecation
    'v5.dep.title': 'Deprecated', 'v5.dep.sunset': 'Stops working on {date} · {rel}', 'v5.dep.sunsetShort': 'sunset {date}', 'v5.dep.noSunset': 'No sunset date in the spec',
    'v5.dep.useInstead': 'Use instead:', 'v5.dep.open': 'Open {name}', 'v5.dep.openTry': 'Try {name}', 'v5.dep.carries': 'Carries over {list}', 'v5.carryAs': '{from} as {to}',
    'v5.dep.noReplacement': 'The spec doesn’t name a replacement.', 'v5.dep.tipUse': 'Use {list}.',
    // Response viewer
    'v5.view.label': 'Body view', 'v5.view.pretty': 'Pretty', 'v5.view.raw': 'Raw', 'v5.view.table': 'Table', 'v5.view.schema': 'Schema', 'v5.view.tableOf': 'Table of {name}',
    'v5.wrap': 'Wrap lines', 'v5.raw.foot': '1 line · {size} · {type}, exactly as received', 'v5.raw.scroll': 'Scroll sideways, or turn on Wrap', 'v5.raw.wrapped': 'Wrapped for reading; the bytes are unchanged', 'v5.searchBody': 'Search the body', 'v5.copyBody': 'Copy body', 'v5.useIn': 'Use {name} in',
    'v5.table.foot': '{rows} rows of {path}', 'v5.table.more': '{n} columns, scroll', 'v5.table.moreLabel': 'Scroll right to see all {n} columns', 'v5.table.page': 'Page {page} of {pages} · {total} in all', 'v5.table.field': 'Field', 'v5.table.value': 'Value',
    'v5.legend.on': 'Returned', 'v5.legend.off': 'Not returned', 'v5.legend.issue': 'Doesn’t match',
    'v5.match.ok': 'Matches schema', 'v5.match.issues': { one: '{n} schema issue', other: '{n} schema issues' },
    'v5.match.okTitle': 'Matches the documented schema', 'v5.match.okBody': 'This body is a valid {model}: {n} properties checked.',
    'v5.match.schema': 'Schema', 'v5.match.checked': 'Checked', 'v5.match.checks': 'Types, formats, patterns, lengths, enums and required properties',
    'v5.match.failTitle': { one: "{n} way this body doesn’t match", other: "{n} ways this body doesn’t match" }, 'v5.match.failBody': 'The API answered 200, but the body doesn’t match {model}, the documented schema:',
    'v5.match.note': 'Sendproof only reports this. The response is shown exactly as received.', 'v5.match.showSchema': 'Show in Schema view', 'v5.match.copy': 'Copy issues',
    'v5.issue.length': 'Expected {n} characters, got {got} ({len})', 'v5.issue.missing': 'Required, but not in the body', 'v5.issue.extra': 'Not in the {model} schema',
    'v5.issue.lenShort': 'expected {n} characters', 'v5.issue.extraShort': 'not in the schema', 'v5.issue.missingShort': 'missing required {name}',
    // Language picker
    'v5.lang.search': 'Search {n} languages', 'v5.lang.label': 'Language', 'v5.lang.sub': 'Numbers and dates follow it', 'v5.lang.english': 'English', 'v5.lang.west': 'Western Europe', 'v5.lang.nordic': 'Nordic',
    'v5.lang.central': 'Central and Eastern Europe', 'v5.lang.rtl': 'Middle East · right to left', 'v5.lang.asia': 'Asia',
    'v5.lang.preview': 'Preview', 'v5.lang.previewRtl': 'Preview · the layout mirrors right to left', 'v5.lang.foot': 'Numbers and dates follow the language. Spec text stays as written.',
  });

  catalogues.ja = {
    locale: 'ja-JP', dir: 'ltr', widths: { mac: { preview: '10.5em', send: '9.5em' }, win: { preview: '11.75em', send: '11em' } },
    'm.request': 'リクエスト', 'm.result': '結果', 'copy.curl': 'cURL としてコピー', 'pick.copy': 'URL をコピー',
    'search': '検索またはコマンドを実行…', 'signIn': 'サインイン', 'display': '表示設定', 'env': '開発環境',
    'operations': 'オペレーション', 'models': 'モデル', 'filter.ops': '絞り込む', 'filter.models': '絞り込む',
    'view.try': '試す', 'view.docs': 'ドキュメント', 'crumbs': 'パンくずリスト', 'view.label': '表示', 'back': '戻る', 'back.to': '{name} に戻る',
    'nav.deprecated': '非推奨', 'nav.locked': 'サインインが必要', 'nav.roles': '{roles} が必要',
    'foot.ops': '{n} 件', 'foot.models': '{n} 件のスキーマ', 'foot.collapseAll': 'すべて折りたたむ', 'foot.expandAll': 'すべて展開', 'expandAll': 'すべて展開', 'collapseAll': 'すべて折りたたむ',
    'tab.body': '本文', 'tab.params': 'パラメーター', 'tab.headers': 'ヘッダー', 'tab.auth': '認証', 'tab.code': 'コード',
    'form': 'フォーム', 'json': 'JSON', 'autofill': '自動入力', 'optional': '任意', 'add': '追加', 'section.body': '本文',
    'preview': 'プレビュー', 'send': '送信', 'cancel': 'キャンセル', 'bar.rule': 'プレビューはロールバック · 送信はコミット',
    'res.response': 'レスポンス', 'res.database': 'データベース', 'res.effects': '副作用', 'res.logs': 'ログ', 'res.headers': 'ヘッダー', 'res.none': 'まだ結果はありません', 'history': '履歴',
    'res.preview': 'プレビュー', 'res.sent': '送信済み', 'res.traced': '送信 · トレース',
    'bar.noRuns': 'このオペレーションはまだ実行されていません', 'bar.lastRun': '{time} に Ada Admin として{what}', 'bar.sendRun': '送信', 'bar.sendTraced': '送信してトレース',
    'json.keys': '{n} 個のキー', 'json.items': '{n} 件',
    'schema.noDesc': '仕様に説明がありません', 'schema.openModel': '{name} モデルを開く', 'schema.treeLabel': '{name} のプロパティ', 'schema.variant': 'バリアント', 'schema.recursive': '再帰',
    'v5.required': '必須', 'v5.optional': '任意', 'v5.clear': 'クリア', 'v5.clearName': '{name} をクリア', 'v5.about': '{name} について',
    'v5.any': '指定なし', 'v5.choose': '値を選択…', 'v5.chooseAn': '{name} を選択…', 'v5.notSent': '未設定のあいだは送信しません', 'v5.sendsValue': '{v} を送信',
    'v5.between': '{min}〜{max}', 'v5.atLeast': '{min} 以上', 'v5.defaultIs': '既定値 {v}', 'v5.upTo': '{n} 文字まで', 'v5.sends': '{id} を送信',
    'v5.lookup.count': '{who} が参照できる顧客 {n} 件', 'v5.sec.path': 'パス', 'v5.sec.filter': '絞り込み', 'v5.sec.paging': 'ページと並び順',
    'v5.readOnly': 'GET は読み取り専用です。ロールバックする変更がないため、プレビューはありません',
    'v5.unsetHint': '送信しないため、絞り込まれません', 'v5.searchN': '{n} 件から検索', 'v5.matches': '{n} 件', 'v5.k.move': '移動', 'v5.k.choose': '選択', 'v5.typed': '入力',
    'v5.view.label': '本文の表示', 'v5.view.pretty': '整形', 'v5.view.raw': 'Raw', 'v5.view.table': '表', 'v5.view.schema': 'スキーマ', 'v5.view.tableOf': '{name} の表',
    'v5.wrap': '折り返す', 'v5.searchBody': '本文を検索', 'v5.copyBody': '本文をコピー', 'v5.useIn': '{name} を次で使う',
    'v5.table.foot': '{path} の {rows} 行', 'v5.table.more': '{n} 列、スクロール', 'v5.table.moreLabel': '右にスクロールして {n} 列すべてを表示', 'v5.table.page': '{page} / {pages} ページ · 全 {total} 件', 'v5.table.field': 'フィールド', 'v5.table.value': '値',
    'v5.match.ok': 'スキーマに一致', 'v5.match.issues': 'スキーマの問題 {n} 件',
  };

  catalogues.he = {
    locale: 'he-IL', dir: 'rtl', widths: { mac: { preview: '11em', send: '9.5em' }, win: { preview: '12.25em', send: '11em' } },
    'm.request': 'בקשה', 'm.result': 'תוצאה', 'copy.curl': 'העתקה כ־cURL', 'pick.copy': 'העתקת ה־URL',
    'search': 'חיפוש או הרצת פקודה…', 'signIn': 'התחברות', 'display': 'הגדרות תצוגה', 'env': 'פיתוח',
    'operations': 'פעולות', 'models': 'מודלים', 'filter.ops': 'סינון פעולות', 'filter.models': 'סינון מודלים',
    'view.try': 'ניסיון', 'view.docs': 'תיעוד', 'crumbs': 'פירורי לחם', 'view.label': 'תצוגת הפעולה', 'back': 'חזרה', 'back.to': 'חזרה אל {name}',
    'nav.deprecated': 'הוצא משימוש', 'nav.locked': 'נדרשת התחברות', 'nav.roles': 'נדרש {roles}',
    'foot.ops': { one: 'פעולה אחת', other: '{n} פעולות' }, 'foot.models': { one: 'סכמה אחת', other: '{n} סכמות' }, 'foot.collapseAll': 'כיווץ הכול', 'foot.expandAll': 'הרחבת הכול', 'expandAll': 'הרחבת הכול', 'collapseAll': 'כיווץ הכול',
    'tab.body': 'גוף', 'tab.params': 'פרמטרים', 'tab.headers': 'כותרות', 'tab.auth': 'הרשאה', 'tab.code': 'קוד',
    'form': 'טופס', 'json': 'JSON', 'autofill': 'מילוי אוטומטי', 'optional': 'אופציונלי', 'add': 'הוספה', 'section.body': 'גוף',
    'preview': 'תצוגה מקדימה', 'send': 'שליחה', 'cancel': 'ביטול', 'bar.rule': 'תצוגה מקדימה מבטלת · שליחה שומרת',
    'res.response': 'תגובה', 'res.database': 'מסד נתונים', 'res.effects': 'תופעות לוואי', 'res.logs': 'יומנים', 'res.headers': 'כותרות', 'res.none': 'אין עדיין תוצאה', 'history': 'היסטוריה',
    'res.preview': 'תצוגה מקדימה', 'res.sent': 'נשלח', 'res.traced': 'נשלח · במעקב',
    'bar.noRuns': 'הפעולה הזו עוד לא הורצה', 'bar.lastRun': '{what} ב־{time} בתור Ada Admin', 'bar.sendRun': 'נשלח', 'bar.sendTraced': 'נשלח ונרשם',
    'json.keys': { one: 'מפתח אחד', other: '{n} מפתחות' }, 'json.items': { one: 'פריט אחד', other: '{n} פריטים' },
    'docs.onPage': 'בעמוד הזה', 'docs.request': 'בקשה', 'docs.responses': 'תגובות', 'docs.auth': 'אימות', 'docs.body': 'גוף', 'docs.overview': 'סקירה',
    'docs.bar': '„ניסיון” פותח את הפעולה עם הדוגמה המתועדת', 'docs.base': 'כתובת בסיס', 'docs.copyBase': 'העתקת כתובת הבסיס', 'docs.aside': 'מתאר ודוגמאות',
    'docs.in.path': 'פרמטרי נתיב', 'docs.in.query': 'פרמטרי שאילתה', 'docs.in.header': 'כותרות', 'docs.props': { one: 'מאפיין אחד', other: '{n} מאפיינים' }, 'docs.required': '{n} חובה',
    'docs.schema': 'סכמה', 'docs.example': 'דוגמה', 'docs.documented': '{n} מתועדות', 'docs.noBody': 'ללא גוף', 'docs.signin': 'התחברות', 'docs.roles': 'תפקיד',
    'docs.rolesBody': { one: 'משתמשים מחוברים בלי התפקיד הזה מקבלים 403.', other: 'מספיק אחד מהתפקידים. משתמשים מחוברים בלי אף אחד מהם מקבלים 403.' },
    'docs.needsSignin': 'נדרשת התחברות', 'docs.signedIn': 'משתמשים מחוברים', 'docs.requestSample': 'דוגמת בקשה', 'docs.responseSample': 'דוגמת תגובה', 'docs.language': 'שפה', 'docs.copySample': 'העתקת הדוגמה',
    'schema.noDesc': 'אין תיאור במפרט', 'schema.openModel': 'פתיחת המודל {name}', 'schema.treeLabel': 'המאפיינים של {name}', 'schema.variant': 'גרסה', 'schema.recursive': 'רקורסיבי',
    'v5.required': 'חובה', 'v5.optional': 'אופציונלי', 'v5.showKids': 'הצגת מאפייני הצאצא', 'v5.hideKids': 'הסתרת מאפייני הצאצא', 'v5.enumValues': 'ערכי enum אפשריים',
    'v5.moreValues': { one: 'הצגת ערך נוסף', other: 'הצגת עוד {n} ערכים' }, 'v5.arrayOf': 'מערך של', 'v5.oneOfN': 'אחד מתוך {n}',
    'v5.f.format': 'פורמט', 'v5.f.range': 'טווח', 'v5.f.min': 'מינימום', 'v5.f.max': 'מקסימום', 'v5.f.maxLength': 'אורך מרבי', 'v5.f.minLength': 'אורך מזערי', 'v5.f.length': 'אורך',
    'v5.f.pattern': 'תבנית', 'v5.f.default': 'ברירת מחדל', 'v5.f.example': 'דוגמה', 'v5.f.readOnly': 'לקריאה בלבד', 'v5.f.step': 'צעד',
    'v5.clear': 'ניקוי', 'v5.clearName': 'ניקוי {name}', 'v5.about': 'מידע על {name}', 'v5.any': 'הכול', 'v5.choose': 'בחירת ערך…', 'v5.chooseAn': 'בחירת {name}…',
    'v5.notSent': 'לא נשלח כל עוד לא נבחר ערך', 'v5.sendsValue': 'נשלח כ־{v}', 'v5.between': 'מ־{min} עד {max}', 'v5.atLeast': 'לפחות {min}', 'v5.defaultIs': 'ברירת מחדל {v}', 'v5.upTo': 'עד {n} תווים',
    'v5.sec.path': 'נתיב', 'v5.sec.filter': 'סינון', 'v5.sec.paging': 'עמוד וסדר', 'v5.readOnly': 'GET היא לקריאה בלבד: אין מה לבטל, ולכן אין תצוגה מקדימה',
    'v5.unsetHint': 'לא נשלח, כך ששום דבר לא מסונן', 'v5.close': 'סגירה', 'v5.searchN': 'חיפוש ב־{n} ערכים', 'v5.matches': '{n} תוצאות', 'v5.k.move': 'מעבר', 'v5.k.choose': 'בחירה', 'v5.typed': 'הוקלד',
  };

  const cat = catalogues[lang] || catalogues.en;
  // Formatting locale: Arabic adds the numbering system the user chose.
  const locale = cat.locale === 'ar' ? `ar-u-nu-${digits}` : cat.locale;
  const plural = new Intl.PluralRules(locale);
  const fill = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

  /** Looks up a string; plural entries take { n }. */
  function t(key, vars) {
    const entry = cat[key] ?? catalogues.en[key] ?? key;
    if (typeof entry === 'object') {
      const n = vars?.n ?? 0;
      const form = entry[plural.select(n)] ?? entry.other;
      return fill(form, { ...vars, n: num(n) });
    }
    return fill(entry, vars);
  }

  const num = (n, opts) => new Intl.NumberFormat(locale, opts).format(n);
  const money = (n, currency = 'EUR') => new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
  const decimal = n => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  const date = (iso, opts = { day: '2-digit', month: '2-digit', year: 'numeric' }) => new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
  const weekday = iso => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
  /** Units such as ms and kB, in the locale's own short form. */
  const unit = (n, u, digits = 0) => new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'short', maximumFractionDigits: digits }).format(n);
  const time = iso => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }).format(new Date(iso));
  // A date placeholder in the user's own order, e.g. dd/mm/yyyy, TT.MM.JJJJ.
  const datePattern = { 'en-IE': 'dd/mm/yyyy', 'de-DE': 'TT.MM.JJJJ', 'ar': 'يوم/شهر/سنة', 'ja-JP': 'yyyy/mm/dd', 'he-IL': 'dd.mm.yyyy' }[cat.locale] || 'yyyy-mm-dd';

  // Shortcut glyphs. Chips on buttons use the compact form (one keycap, symbols); tooltips,
  // menus and the shortcut sheet use the long form ("Ctrl+Shift+Enter").
  // Modifier order follows each platform: ⌥⇧⌘ on Mac, Ctrl+Shift+Alt on Windows.
  const mac = platform === 'mac';
  const order = mac ? ['alt', 'shift', 'mod'] : ['mod', 'shift', 'alt'];
  const compact = mac ? { mod: '⌘', shift: '⇧', alt: '⌥', enter: '↵' } : { mod: 'Ctrl\u2009', shift: '⇧', alt: 'Alt\u2009', enter: '↵' };
  const long = mac ? { mod: '⌘', shift: '⇧', alt: '⌥', enter: 'Return' } : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter' };
  const sorted = keys => [...keys].sort((a, b) => (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9));
  /** chord('shift', 'mod', 'enter') → "⇧⌘↵" (Mac) or "Ctrl ⇧↵" (Windows). */
  const chord = (...keys) => sorted(keys).map(k => compact[k] ?? k).join('');
  /** The long form for tooltips: "⇧⌘Return" or "Ctrl+Shift+Enter". */
  const chordLong = (...keys) => sorted(keys).map(k => long[k] ?? k).join(mac ? '' : '+');

  document.documentElement.lang = lang;
  document.documentElement.dir = cat.dir;
  document.documentElement.style.setProperty('--w-preview', cat.widths[platform].preview);
  document.documentElement.style.setProperty('--w-send', cat.widths[platform].send);

  window.i18n = { lang, platform, digits, locale, dir: cat.dir, t, num, money, decimal, date, weekday, time, unit, datePattern, chord, chordLong };
})();
