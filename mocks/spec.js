// The OpenAPI document and sample responses the mocks render: the "Acme Store API", an online
// store (catalog products and variants, inventory, customers, carts, orders, payments and
// refunds, shipments, reviews, coupons, users and roles).
//
// This file is hand-written and deterministic. It has the shape of the document that
// tools/mock-spec.mjs snapshots from a running store example (window.TB_SPEC is the OpenAPI
// document, window.TB_SAMPLES the response bodies the screens show), so the snapshot tool can
// replace it without any screen changing, as long as the operation IDs and sample names below
// still exist. Small builders keep the document readable; every value ends up as plain JSON.
(function () {
  /* ---------- Builders ---------- */
  const ref = name => ({ $ref: `#/components/schemas/${name}` });
  /** A description beside a $ref, which is how the generated documents write a described reference. */
  const refd = (name, description) => ({ description, ...ref(name) });
  const RFC = 'https://tools.ietf.org/html/rfc9110#section-';
  const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
  const nstr = (description, extra = {}) => ({ type: ['null', 'string'], description, ...extra });
  const uuid = (description, extra = {}) => str(description, { format: 'uuid', ...extra });
  const dec = (description, extra = {}) => ({ type: 'number', description, format: 'decimal', ...extra });
  const int = (description, extra = {}) => ({ type: 'integer', description, format: 'int32', ...extra });
  const date = (description, extra = {}) => str(description, { format: 'date', ...extra });
  const stamp = (description, extra = {}) => str(description, { format: 'date-time', ...extra });
  const arr = (items, description, extra = {}) => ({ type: 'array', items, description, ...extra });
  /** A nullable reference: `oneOf` null or the described schema. */
  const maybe = (name, description) => ({ oneOf: [{ type: 'null' }, refd(name, description)] });
  /** An ID that the workbench can turn into a pick list (see x-lookup). */
  const lookup = (url, labelField, detailField, statusField) => ({ url, valueField: 'id', labelField, detailField, ...(statusField ? { statusField } : {}) });
  const customerLookup = '/api/v2/customers?pageSize=100';
  const L = {
    customer: lookup(customerLookup, 'name', 'email'),
    customerActive: lookup('/api/v2/customers?status=Active&pageSize=100', 'name', 'email'),
    product: lookup('/api/v2/products?pageSize=100', 'name', 'sku'),
    variant: lookup('/api/v2/variants?pageSize=100', 'name', 'sku'),
    variantActive: lookup('/api/v2/variants?active=true&pageSize=100&sort=name', 'name', 'sku'),
    order: lookup('/api/v2/orders?pageSize=50', 'number', 'reference', 'status'),
    payment: lookup('/api/v2/payments?pageSize=50', 'number', 'orderNumber', 'status'),
    shipment: lookup('/api/v2/shipments?pageSize=50', 'trackingNumber', 'carrier', 'status'),
    cart: lookup('/api/v2/carts?pageSize=50', 'id', 'customerName'),
    coupon: lookup('/api/v2/coupons?pageSize=100', 'code', 'description', 'status'),
    review: lookup('/api/v2/reviews?pageSize=50', 'title', 'productName', 'status'),
    user: lookup('/api/v2/users?pageSize=100', 'name', 'email'),
  };
  const withLookup = (schema, l) => ({ ...schema, 'x-lookup': l });

  /** An enum schema; `values` maps each value to its description. */
  const enumOf = (description, values) => ({ enum: Object.keys(values), type: 'string', description, 'x-enum-descriptions': values });
  /** An object schema, with an optional example that the model page shows. */
  const obj = (description, properties, required, example, extra = {}) => ({
    ...(example ? { examples: [example] } : {}), required, type: 'object', properties, description, ...extra,
  });

  const problem = (schemaName, example) => ({ 'application/problem+json': { schema: ref(schemaName), example } });
  const standard = {
    400: () => ({ description: 'A field was missing or invalid. The `errors` object names each one.', content: problem('HttpValidationProblemDetails', { type: `${RFC}15.5.1`, title: 'One or more validation errors occurred.', status: 400, errors: { quantity: ['Quantity must be between 1 and 99.'], deliverBy: ['Deliver-by date must be today or later.'] } }) }),
    401: () => ({ description: 'Not signed in. Sign in with `AuthController.Login` or switch persona, then retry.', content: problem('ProblemDetails', { type: `${RFC}15.5.2`, title: 'Unauthorized', status: 401, detail: 'You are not signed in.' }) }),
    403: roles => ({ description: `Signed in without the ${roles}.`, content: problem('ProblemDetails', { type: `${RFC}15.5.4`, title: 'Forbidden', status: 403, detail: 'Your role may not perform this operation.' }) }),
    404: noun => ({ description: `No ${noun} has this ID.`, content: problem('ProblemDetails', { type: `${RFC}15.5.5`, title: 'Not found', status: 404, detail: `No ${noun} exists with ID 7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13.` }) }),
    409: (description, detail) => ({ description, content: problem('ProblemDetails', { type: `${RFC}15.5.10`, title: 'Conflict', status: 409, detail }) }),
    422: (description, detail) => ({ description, content: problem('ProblemDetails', { type: `${RFC}15.5.21`, title: 'Business rule violated', status: 422, detail }) }),
  };
  const json = (description, schema) => ({ description, content: { 'application/json': { schema } } });

  const pageParam = { name: 'page', in: 'query', description: 'The 1-based page number.', schema: { minimum: 1, type: 'integer', format: 'int32', default: 1 } };
  const pageSizeParam = noun => ({ name: 'pageSize', in: 'query', description: `How many ${noun} to return per page, from 1 to 100.`, schema: { maximum: 100, minimum: 1, type: 'integer', format: 'int32', default: 25 } });
  const q = description => ({ name: 'q', in: 'query', description, schema: { maxLength: 100, type: 'string' } });
  const sortParam = (defaultText, values) => ({ name: 'sort', in: 'query', description: `The sort order: a field name, with a leading minus for descending. ${defaultText}`, schema: { enum: Object.keys(values), type: 'string', 'x-enum-descriptions': values } });
  const query = (name, description, schema) => ({ name, in: 'query', description, schema });
  const idParam = (name, description, l) => ({ name, in: 'path', description, required: true, schema: withLookup({ type: 'string', format: 'uuid' }, l) });
  const body = (description, schemaName) => ({ description, content: { 'application/json': { schema: ref(schemaName) } }, required: true });

  /**
   * One operation. `roles` lists the roles that may call it (each becomes its own security
   * requirement); an empty list means any signed-in user, null means no sign-in at all.
   * `errors` maps a status to a ready response, `ok` is [status, response] pairs.
   */
  const op = ({ tag, id, summary, description, parameters, requestBody, ok, errors = {}, roles = [], extra = {} }) => ({
    tags: [tag], summary, description, operationId: id,
    ...(parameters ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: Object.fromEntries([...ok, ...Object.entries(errors)].sort(([a], [b]) => a - b)),
    ...(roles === null ? {} : { security: roles.length ? roles.map(role => ({ cookieAuth: [role] })) : [{ cookieAuth: [] }] }),
    ...extra,
  });
  const staff = ['admin', 'support'];
  const staffText = 'Requires the `admin` or `support` role.';

  /* ---------- Enums ---------- */
  const enums = {
    Currency: enumOf('The ISO 4217 currencies the store sells in.', {
      EUR: 'Euro', USD: 'US dollar', GBP: 'Pound sterling', CHF: 'Swiss franc', SEK: 'Swedish krona', JPY: 'Japanese yen',
      NOK: 'Norwegian krone', DKK: 'Danish krone', CAD: 'Canadian dollar', AUD: 'Australian dollar', PLN: 'Polish złoty',
    }),
    CustomerSegment: enumOf('The kind of customer, which decides default prices and payment terms.', {
      Individual: 'A shopper buying for themselves.', Business: 'A company buying for its own use.', Wholesale: 'A reseller with trade pricing.',
      Student: 'A verified student with an education discount.', Staff: 'An Acme employee with the staff discount.',
    }),
    CustomerStatus: enumOf('Whether the customer can sign in and place orders.', {
      Active: 'Can sign in and order.', Suspended: 'Signed in but blocked from ordering, usually after repeated chargebacks.', Closed: 'Account closed at the customer’s request. Kept for order history.',
    }),
    ProductCategory: enumOf('The shelf a product is listed on.', {
      Apparel: 'Clothing, shoes and accessories.', Home: 'Furniture, kitchen and bedding.', Electronics: 'Audio, lighting and computer accessories.', Outdoors: 'Camping, hiking and bottles.',
    }),
    ProductStatus: enumOf('Whether the product is on sale.', { Active: 'Listed and available to order.', Archived: 'Removed from the catalog. Kept for order history.' }),
    OrderStatus: enumOf('Lifecycle of an order, from first checkout to delivery.', {
      Pending: 'Placed, waiting for payment.', Paid: 'Payment captured, waiting to be picked.', Processing: 'Being picked in the warehouse.', Packed: 'Packed, waiting for the carrier.',
      Shipped: 'Handed to the carrier.', Delivered: 'The carrier confirmed delivery.', Cancelled: 'Cancelled before it was shipped.', Refunded: 'Fully refunded after payment.', PaymentFailed: 'The payment was declined.',
    }),
    ShippingMethod: enumOf('How quickly the order is delivered.', { Standard: 'Delivered in 3 to 5 working days.', Express: 'Delivered next working day.', 'Same day': 'Delivered today if ordered before 14:00 in the delivery area.' }),
    Channel: enumOf('Where the order was placed.', { Web: 'The online store.', App: 'The mobile app.', Phone: 'Entered by a support agent on a call.' }),
    PaymentStatus: enumOf('Lifecycle of a payment.', {
      Authorized: 'The card was authorized; the money is held, not yet taken.', Captured: 'The money was taken.', Failed: 'The provider declined the payment.', PartiallyRefunded: 'Some of the money was returned.', Refunded: 'All of the money was returned.', Voided: 'The authorization was released without taking money.',
    }),
    RefundReason: enumOf('Why a refund was issued.', { Damaged: 'Arrived damaged.', WrongItem: 'The wrong item was sent.', NotAsDescribed: 'Not as described on the product page.', CustomerRequest: 'The customer changed their mind.' }),
    ShipmentStatus: enumOf('Where a parcel is.', { Preparing: 'Label created, parcel not yet scanned.', InTransit: 'With the carrier.', OutForDelivery: 'On the delivery vehicle.', Delivered: 'Delivered.', Exception: 'The carrier reported a problem, such as a failed delivery.' }),
    ReviewStatus: enumOf('Where a review is in moderation.', { Pending: 'Waiting for a moderator.', Published: 'Visible on the product page.', Rejected: 'Not published.' }),
    ModerationDecision: { enum: ['Approve', 'Reject'], type: 'string', description: 'A moderator’s decision on a review.' },
    CouponType: { enum: ['Percentage', 'FixedAmount'], type: 'string', description: 'How a coupon takes money off.' },
    CouponStatus: { enum: ['Active', 'Expired', 'Deactivated'], type: 'string', description: 'Whether a coupon can still be redeemed.' },
    StockMovementType: { enum: ['Receipt', 'Sale', 'Return', 'Adjustment'], type: 'string', description: 'Why stock went up or down.' },
    RoleName: { enum: ['admin', 'support', 'customer'], type: 'string', description: 'The roles that control what a user may do.' },
  };

  /* ---------- Shared building blocks ---------- */
  const countryProp = description => ({ maxLength: 2, minLength: 2, pattern: '^[A-Z]{2}$', type: 'string', description });
  const schemas = {
    ...enums,
    Address: obj('A postal address.', {
      line: str('Street and number.', { maxLength: 70 }),
      city: str('The town or city.', { maxLength: 35 }),
      postalCode: nstr('The postal or ZIP code, where the country uses one.', { maxLength: 16 }),
    }, ['line', 'city']),
    MoneyAmount: obj('A monetary amount with its currency.', {
      value: dec('The amount, with at most two decimal places (none for JPY).'),
      currency: refd('Currency', 'The ISO 4217 currency of the amount.'),
    }, ['value', 'currency']),
    ActorReference: obj('A person who took an action, such as placing an order or moderating a review.', {
      email: str('The person’s sign-in email address.', { format: 'email' }),
      name: str('The person’s display name.'),
    }, ['email', 'name']),
    CustomerReference: obj('A customer, in brief.', {
      id: uuid('The customer’s ID.'), name: str('The customer’s name.'), email: str('Where order updates are sent.', { format: 'email' }),
    }, ['id', 'name', 'email']),
    VariantReference: obj('A product variant, in brief.', {
      id: uuid('The variant’s ID.'), name: str('The product and variant name, such as `Merino Crew Sweater, Heather Grey / M`.'), sku: str('The variant’s stock-keeping unit.'), currency: refd('Currency', 'The currency of the variant’s price.'),
    }, ['id', 'name', 'sku']),
    OrderReference: obj('An order, in brief.', {
      id: uuid('The order’s ID.'), number: str('The order number, such as `ORD-2026-000123`.'), customerName: str('Who placed it.'),
    }, ['id', 'number']),
    ProductReference: obj('A product, in brief.', { id: uuid('The product’s ID.'), name: str('The product name.'), sku: str('The product’s base SKU.') }, ['id', 'name']),
  };

  /* ---------- Customers ---------- */
  schemas.Customer = obj('A person or company that buys from the store.', {
    id: uuid('The customer’s unique ID.'),
    name: str('The customer’s name, or the company’s registered name.'),
    email: str('The sign-in and order-update address.', { format: 'email' }),
    phone: nstr('A contact number for the carrier, in international format.'),
    country: countryProp('The ISO 3166-1 alpha-2 country of the default address.'),
    defaultAddress: maybe('Address', 'Where orders go unless the customer picks another address.'),
    currency: refd('Currency', 'The currency the customer pays in.'),
    segment: refd('CustomerSegment', 'The kind of customer.'),
    status: refd('CustomerStatus', 'Whether the customer can sign in and order.'),
    lifetimeSpend: dec('Everything the customer has paid, less refunds, in their currency.'),
    ordersCount: int('How many orders the customer has placed.'),
    loyaltyPoints: int('Loyalty points the customer can still spend.'),
    marketingOptIn: { type: 'boolean', description: 'Whether the customer agreed to marketing email.' },
    joinedOn: date('The date the customer registered.'),
    closedOn: nstr('The date the account was closed. Absent while it is open.', { format: 'date' }),
    notes: nstr('A free-text note from support, such as a delivery preference.'),
  }, ['id', 'name', 'email', 'country', 'currency', 'segment', 'status', 'lifetimeSpend', 'ordersCount', 'joinedOn'], {
    id: '3f9c0000-0000-4000-8000-00000000a21e', name: 'Priya Raman', email: 'priya.raman@example.com', phone: '+353 87 555 0142', country: 'IE',
    defaultAddress: { line: '14 Marlay Park Road', city: 'Dublin', postalCode: 'D16 X2P4' }, currency: 'EUR', segment: 'Individual', status: 'Active',
    lifetimeSpend: 1284.7, ordersCount: 9, loyaltyPoints: 640, marketingOptIn: true, joinedOn: '2024-03-18', closedOn: null, notes: 'Leave parcels with the concierge, flat 4B.',
  });
  schemas.CreateCustomerRequest = obj('Fields used to register a customer.', {
    name: str('The customer’s name.', { maxLength: 120 }),
    email: str('A unique email address.', { format: 'email' }),
    country: countryProp('The ISO 3166-1 alpha-2 country.'),
    currency: refd('Currency', 'The currency the customer pays in.'),
    segment: refd('CustomerSegment', 'The kind of customer. Defaults to `Individual`.'),
    phone: nstr('A contact number, in international format.'),
    defaultAddress: maybe('Address', 'The default delivery address.'),
    marketingOptIn: { type: 'boolean', description: 'Whether the customer agreed to marketing email.' },
    notes: nstr('A free-text note for support.', { maxLength: 500 }),
  }, ['name', 'email', 'country', 'currency'], {
    name: 'Priya Raman', email: 'priya.raman@example.com', country: 'IE', currency: 'EUR', segment: 'Individual', defaultAddress: { line: '14 Marlay Park Road', city: 'Dublin', postalCode: 'D16 X2P4' }, marketingOptIn: true,
  });
  schemas.UpdateCustomerRequest = obj('The values to change on a customer. Fields you leave out are kept.', {
    name: str('The customer’s name.', { maxLength: 120 }),
    phone: nstr('A contact number, in international format.'),
    segment: refd('CustomerSegment', 'The kind of customer.'),
    notes: nstr('A free-text note for support.', { maxLength: 500 }),
  }, []);

  /* ---------- Products and variants ---------- */
  const fulfilmentType = value => ({ enum: [value], type: 'string', description: `Always \`${value}\` for this variant. It tells the variants of the union apart.` });
  schemas.Fulfilment = {
    required: ['type'], type: 'object',
    oneOf: [ref('FulfilmentPhysical'), ref('FulfilmentDigital'), ref('FulfilmentSubscription')],
    description: 'How a product reaches the customer. The `type` property selects the variant:\n`Physical` for parcels, `Digital` for downloads and gift cards, and `Subscription` for repeat deliveries.',
    discriminator: { propertyName: 'type', mapping: { Physical: '#/components/schemas/FulfilmentPhysical', Digital: '#/components/schemas/FulfilmentDigital', Subscription: '#/components/schemas/FulfilmentSubscription' } },
  };
  schemas.FulfilmentPhysical = {
    examples: [{ type: 'Physical', weightGrams: 640, lengthCm: 34, widthCm: 26, heightCm: 6, hsCode: '611011' }],
    required: ['weightGrams', 'type'],
    properties: {
      type: fulfilmentType('Physical'),
      weightGrams: int('The packed weight in grams, used to quote carrier rates.', { minimum: 1 }),
      lengthCm: nstr('The packed length in centimetres.', { type: ['null', 'number'] }),
      widthCm: { type: ['null', 'number'], description: 'The packed width in centimetres.' },
      heightCm: { type: ['null', 'number'], description: 'The packed height in centimetres.' },
      hsCode: { pattern: '^[0-9]{6,10}$', type: ['null', 'string'], description: 'The customs tariff code, 6 to 10 digits, for orders that cross a border.' },
    },
    description: 'A parcel shipped from a warehouse.',
  };
  schemas.FulfilmentDigital = {
    examples: [{ type: 'Digital', delivery: 'Email', downloadLimit: 3, licenseRequired: false }],
    required: ['delivery', 'type'],
    properties: {
      type: fulfilmentType('Digital'),
      delivery: { enum: ['Email', 'Download'], type: 'string', description: 'Whether the customer gets a code by email or a download link.' },
      downloadLimit: { minimum: 1, type: ['null', 'integer'], description: 'How many times the customer can download it.', format: 'int32' },
      licenseRequired: { type: 'boolean', description: 'Whether a licence key is generated for each order line.' },
    },
    description: 'A download, licence or gift card delivered electronically.',
  };
  schemas.FulfilmentSubscription = {
    examples: [{ type: 'Subscription', intervalDays: 30, weightGrams: 500, skipAllowed: true }],
    required: ['intervalDays', 'weightGrams', 'type'],
    properties: {
      type: fulfilmentType('Subscription'),
      intervalDays: int('Days between deliveries, 7 to 365.', { minimum: 7, maximum: 365 }),
      weightGrams: int('The packed weight of one delivery in grams.', { minimum: 1 }),
      skipAllowed: { type: 'boolean', description: 'Whether the customer can skip a delivery without cancelling.' },
    },
    description: 'A product delivered again every few days until the customer cancels.',
  };
  schemas.ProductVariant = obj('One purchasable version of a product, such as a size and colour.', {
    id: uuid('The variant’s unique ID.'),
    productId: uuid('The product the variant belongs to.'),
    productName: str('The product’s name.'),
    sku: str('The stock-keeping unit, unique across the catalog.', { maxLength: 32 }),
    name: str('The variant’s display name, such as `Heather Grey / M`.'),
    options: { type: 'object', additionalProperties: { type: 'string' }, description: 'The option values that make this variant, keyed by option name, such as `colour` and `size`.' },
    price: dec('The list price, in the variant’s currency.', { minimum: 0 }),
    compareAtPrice: { type: ['null', 'number'], description: 'The price before a markdown, shown struck through. Absent when the variant is not marked down.', format: 'decimal' },
    currency: refd('Currency', 'The currency of the prices.'),
    active: { type: 'boolean', description: 'Whether the variant can be ordered.' },
  }, ['id', 'productId', 'productName', 'sku', 'name', 'price', 'currency', 'active'], {
    id: '9a1f0000-0000-4000-8000-00000000c301', productId: '5b7c0000-0000-4000-8000-00000000b123', productName: 'Merino Crew Sweater', sku: 'APP-MCS-HGR-M', name: 'Heather Grey / M',
    options: { colour: 'Heather Grey', size: 'M' }, price: 79, compareAtPrice: 99, currency: 'EUR', active: true,
  });
  schemas.Product = obj('A product in the catalog, with its variants.', {
    id: uuid('The product’s unique ID.'),
    name: str('The product’s name.'),
    sku: str('The base SKU; each variant adds its option codes.'),
    category: refd('ProductCategory', 'The shelf the product is listed on.'),
    brand: nstr('The brand, when it is not Acme’s own.'),
    status: refd('ProductStatus', 'Whether the product can be ordered. Archived products are kept for history.'),
    originCountry: countryProp('The ISO 3166-1 alpha-2 country the product is made in.'),
    shipsFrom: refd('Address', 'The warehouse the product ships from.'),
    supplierEmail: nstr('Where restock requests are sent.', { format: 'email' }),
    fulfilment: refd('Fulfilment', 'How the product reaches the customer. The `type` property tells which variant it is.'),
    variants: arr(ref('ProductVariant'), 'The versions customers can buy.'),
    averageRating: { type: ['null', 'number'], description: 'The mean of the published reviews, 1 to 5. Absent until the first review.', format: 'double' },
    createdAt: stamp('When the product was added to the catalog.'),
  }, ['id', 'name', 'sku', 'category', 'status', 'originCountry', 'shipsFrom', 'fulfilment', 'variants', 'createdAt'], {
    id: '5b7c0000-0000-4000-8000-00000000b123', name: 'Merino Crew Sweater', sku: 'APP-MCS', category: 'Apparel', brand: null, status: 'Active', originCountry: 'PT',
    shipsFrom: { line: 'Zona Industrial, Lote 12', city: 'Guimarães', postalCode: '4810-100' }, supplierEmail: 'orders@lusotricot.example',
    fulfilment: { type: 'Physical', weightGrams: 640, lengthCm: 34, widthCm: 26, heightCm: 6, hsCode: '611011' },
    variants: [{ id: '9a1f0000-0000-4000-8000-00000000c301', productId: '5b7c0000-0000-4000-8000-00000000b123', productName: 'Merino Crew Sweater', sku: 'APP-MCS-HGR-M', name: 'Heather Grey / M', options: { colour: 'Heather Grey', size: 'M' }, price: 79, compareAtPrice: 99, currency: 'EUR', active: true }],
    averageRating: 4.6, createdAt: '2025-10-16T09:00:00Z',
  });
  schemas.CreateProductRequest = obj('Fields used to add a product to the catalog.', {
    name: str('The product’s name.', { maxLength: 120 }),
    sku: str('A base SKU, unique across the catalog.', { maxLength: 24, pattern: '^[A-Z0-9-]{3,24}$' }),
    category: refd('ProductCategory', 'The shelf to list the product on.'),
    originCountry: countryProp('The ISO 3166-1 alpha-2 country the product is made in.'),
    shipsFrom: refd('Address', 'The warehouse the product ships from.'),
    fulfilment: refd('Fulfilment', 'How the product reaches the customer.'),
    brand: nstr('The brand, when it is not Acme’s own.', { maxLength: 60 }),
    supplierEmail: nstr('Where restock requests are sent.', { format: 'email' }),
  }, ['name', 'sku', 'category', 'originCountry', 'shipsFrom', 'fulfilment']);
  schemas.UpdateProductRequest = obj('The new values for a product. Fields you leave out are kept.', {
    name: str('The product’s name.', { maxLength: 120 }),
    category: refd('ProductCategory', 'The shelf to list the product on.'),
    brand: nstr('The brand.', { maxLength: 60 }),
    supplierEmail: nstr('Where restock requests are sent.', { format: 'email' }),
  }, []);

  /* ---------- Inventory ---------- */
  schemas.StockLevel = obj('The stock of one variant across all warehouses.', {
    variant: refd('VariantReference', 'The variant counted.'),
    onHand: int('Units physically in the warehouses.'),
    reserved: int('Units held for orders that are paid but not yet shipped.'),
    available: int('Units that can still be sold: on hand less reserved.'),
    asOf: stamp('When the count was last updated.'),
  }, ['variant', 'onHand', 'reserved', 'available', 'asOf'], {
    variant: { id: '9a1f0000-0000-4000-8000-00000000c301', name: 'Merino Crew Sweater, Heather Grey / M', sku: 'APP-MCS-HGR-M', currency: 'EUR' }, onHand: 84, reserved: 6, available: 78, asOf: '2026-11-20T09:00:00Z',
  });
  schemas.StockMovement = obj('One change to a variant’s stock.', {
    id: uuid('The movement’s unique ID.'),
    type: refd('StockMovementType', 'Why the stock changed.'),
    quantity: int('The units added (positive) or removed (negative).'),
    onHandAfter: int('The on-hand count after the movement.'),
    reference: nstr('The order number, purchase order or adjustment note behind it.'),
    occurredAt: stamp('When it happened.'),
  }, ['id', 'type', 'quantity', 'onHandAfter', 'occurredAt']);
  schemas.LegacyStock = obj('The units available for one variant, in the format of the original API.', {
    variantId: uuid('The variant counted.'), available: int('Units that can still be sold.'), asOf: stamp('When the count was last updated.'),
  }, ['variantId', 'available', 'asOf']);

  /* ---------- Carts and price quotes ---------- */
  schemas.CartLine = obj('One variant in a cart.', {
    variant: refd('VariantReference', 'The variant in the cart.'), quantity: int('How many.', { minimum: 1, maximum: 99 }), unitPrice: dec('The price per unit when it was added.'),
  }, ['variant', 'quantity', 'unitPrice']);
  schemas.Cart = obj('A customer’s basket before checkout. Carts expire after 14 days without a change.', {
    id: uuid('The cart’s unique ID.'),
    customer: maybe('CustomerReference', 'The customer who owns the cart. Absent for a guest.'),
    lines: arr(ref('CartLine'), 'What is in the cart.'),
    currency: refd('Currency', 'The currency of the prices.'),
    subtotal: dec('The sum of the lines, before discounts, shipping and tax.'),
    updatedAt: stamp('When the cart last changed.'),
  }, ['id', 'lines', 'currency', 'subtotal', 'updatedAt']);
  schemas.CreateCartRequest = obj('Fields used to start a cart.', {
    customerId: withLookup(uuid('The customer who owns the cart. Leave out for a guest cart.', {}), L.customerActive),
    currency: refd('Currency', 'The currency to price the cart in.'),
    lines: arr(obj('One variant to add.', { variantId: withLookup(uuid('The variant to add.'), L.variantActive), quantity: int('How many.', { minimum: 1, maximum: 99 }) }, ['variantId', 'quantity']), 'The variants to start with.'),
  }, ['currency', 'lines']);
  schemas.CartQuoteRequest = obj('What to price a cart with.', {
    shipTo: countryProp('The ISO 3166-1 alpha-2 country the order ships to.'),
    shippingMethod: refd('ShippingMethod', 'How the order would be delivered. Defaults to `Standard`.'),
    couponCode: { pattern: '^[A-Z0-9]{4,16}$', type: ['null', 'string'], description: 'A coupon to apply, such as `SPRING25`.' },
    currency: refd('Currency', 'Quote in this currency instead of the cart’s.'),
    validForMinutes: int('How long the quote stays valid, 5 to 60 minutes.', { minimum: 5, maximum: 60, default: 15 }),
  }, ['shipTo']);
  schemas.CartQuote = obj('A price for a cart that the store promises to honour until it expires.', {
    quoteId: str('The quote’s ID, to pass when placing the order.'),
    cartId: uuid('The cart priced.'),
    currency: refd('Currency', 'The currency of every amount.'),
    subtotal: dec('The sum of the lines.'),
    discount: dec('The coupon discount, zero when there is none.'),
    shipping: dec('The delivery charge.'),
    tax: dec('The tax included in the total.'),
    total: dec('What the customer would pay.'),
    expiresAt: stamp('When the quote stops being valid. It is held in Redis until then.'),
  }, ['quoteId', 'cartId', 'currency', 'subtotal', 'discount', 'shipping', 'tax', 'total', 'expiresAt'], {
    quoteId: 'Q-7F3A91C2', cartId: 'c4a90000-0000-4000-8000-00000000d701', currency: 'EUR', subtotal: 207.9, discount: 20.79, shipping: 0, tax: 34.99, total: 187.11, expiresAt: '2026-11-20T14:17:11Z',
  });

  /* ---------- Orders ---------- */
  schemas.OrderLine = obj('One variant on an order.', {
    id: uuid('The line’s unique ID.'),
    variant: refd('VariantReference', 'What was ordered.'),
    quantity: int('How many units.'),
    unitPrice: dec('The price per unit, before the line discount.'),
    discount: dec('The coupon discount taken off this line.'),
    total: dec('The line total after the discount.'),
    shipped: int('How many units have shipped so far.'),
  }, ['id', 'variant', 'quantity', 'unitPrice', 'total']);
  schemas.DeliveryNotes = obj('Free-text instructions for the carrier.', {
    lines: arr(str('One instruction.'), 'The instructions, one per line.'),
    packingSlipId: str('The packing slip the notes are printed on.'),
  }, ['lines']);
  schemas.Order = obj('An order from a customer.', {
    id: uuid('The order’s unique ID.'),
    number: str('The human-friendly order number, such as `ORD-2026-000123`.'),
    status: refd('OrderStatus', 'Where the order is in its lifecycle.'),
    customer: refd('CustomerReference', 'Who placed the order.'),
    shippingAddress: refd('Address', 'Where it is delivered.'),
    lines: arr(ref('OrderLine'), 'What was ordered.'),
    amount: dec('The order total, in the order currency.', { multipleOf: 0.01 }),
    currency: refd('Currency', 'The currency of the amount.'),
    deliverBy: date('The date the customer wants the order delivered.'),
    shippingMethod: refd('ShippingMethod', 'How it is delivered.'),
    reference: nstr('The customer’s purchase order or note, shown on the invoice.'),
    couponCode: nstr('The coupon applied at checkout.'),
    deliveryNotes: { oneOf: [{ type: 'null' }, refd('DeliveryNotes', 'Instructions for the carrier.')] },
    channel: { oneOf: [{ type: 'null' }, refd('Channel', 'Where the order was placed.')] },
    externalId: nstr('The caller’s own identifier for the order.'),
    createdBy: refd('ActorReference', 'The person or agent who created the order.'),
    createdAt: stamp('When the order was created.'),
    updatedAt: stamp('When the order last changed.'),
    placedAt: nstr('When the customer completed checkout.', { format: 'date-time' }),
    cancelReason: nstr('Why the order was cancelled. Present only on cancelled orders.'),
  }, ['id', 'number', 'status', 'customer', 'shippingAddress', 'lines', 'amount', 'currency', 'deliverBy', 'shippingMethod', 'createdBy', 'createdAt', 'updatedAt'], {
    id: '7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13', number: 'ORD-2026-000187', status: 'Processing',
    customer: { id: '3f9c0000-0000-4000-8000-00000000a21e', name: 'Priya Raman', email: 'priya.raman@example.com' },
    shippingAddress: { line: '14 Marlay Park Road', city: 'Dublin', postalCode: 'D16 X2P4' },
    lines: [{ id: '0b8d3f0e-2d4a-4c7e-9a41-5f6a7b8c9d01', variant: { id: '9a1f0000-0000-4000-8000-00000000c301', name: 'Merino Crew Sweater, Heather Grey / M', sku: 'APP-MCS-HGR-M', currency: 'EUR' }, quantity: 2, unitPrice: 79, discount: 15.8, total: 142.2, shipped: 0 }],
    amount: 142.2, currency: 'EUR', deliverBy: '2026-11-23', shippingMethod: 'Standard', reference: 'PO-2026-1184 / Q4 uniforms', couponCode: 'SPRING25',
    deliveryNotes: { lines: ['Leave with the concierge, flat 4B'], packingSlipId: 'PS-2026-000187' }, channel: 'Web', externalId: 'ERP-4400123',
    createdBy: { email: 'cara.customer@acme.dev', name: 'Cara Customer' }, createdAt: '2026-11-18T09:00:00Z', updatedAt: '2026-11-20T08:00:00Z', placedAt: '2026-11-18T09:04:00Z', cancelReason: null,
  });
  schemas.CreateOrderRequest = obj('Fields used to place an order on a customer’s behalf.', {
    customerId: withLookup(uuid('The customer placing the order. The account must be active.', { title: 'Customer' }), L.customerActive),
    variantId: withLookup(uuid('The variant to order. It must be active and in stock.', { title: 'Variant' }), L.variantActive),
    unitPrice: dec('The price per unit, in the order currency, to at most two decimal places. Support agents can override the catalog price.', { multipleOf: 0.01, maximum: 999999999999.99, minimum: 0.01, 'x-currency-field': 'currency', 'x-sendproof-row': 'order-details', 'x-sendproof-type-label': 'decimal · ≥ 0.01' }),
    currency: refd('Currency', 'The ISO 4217 currency of the order. It must match the customer’s currency.'),
    deliverBy: date('The date the customer wants the order delivered. It cannot be in the past.', { title: 'Deliver by', 'x-sendproof-row': 'order-details' }),
    shippingMethod: { ...ref('ShippingMethod'), description: 'How quickly to deliver: `Standard`, `Express` or `Same day`.', 'x-sendproof-visible': true },
    reference: nstr('The purchase order or note shown on the invoice, up to 35 characters.', { maxLength: 35, 'x-sendproof-visible': true }),
    deliveryNotes: { maxItems: 4, type: ['null', 'array'], items: { maxLength: 140, type: 'string', description: 'One line of instructions for the carrier.' }, description: 'Up to four instruction lines of at most 140 characters for the carrier.', 'x-sendproof-visible': true },
    quantity: int('How many units, from 1 to 99. Defaults to 1.', { minimum: 1, maximum: 99, default: 1 }),
    channel: { oneOf: [{ type: 'null' }, refd('Channel', 'Where the order was placed. Defaults to `Phone` for support agents.')] },
    couponCode: { pattern: '^[A-Z0-9]{4,16}$', type: ['null', 'string'], description: 'A coupon to apply, such as `SPRING25`.' },
    externalId: nstr('The caller’s own identifier for the order, up to 64 characters.', { maxLength: 64 }),
  }, ['customerId', 'variantId', 'currency', 'deliverBy', 'unitPrice'], {
    customerId: '3f9c0000-0000-4000-8000-00000000a21e', variantId: '9a1f0000-0000-4000-8000-00000000c301', unitPrice: 79, currency: 'EUR', deliverBy: '2026-11-23', shippingMethod: 'Standard', reference: 'PO-2026-1184 / Q4 uniforms', deliveryNotes: ['Leave with the concierge, flat 4B'],
  });
  schemas.UpdateOrderRequest = obj('The new delivery details for an order that has not shipped. Every field is replaced.', {
    deliverBy: date('The date the customer wants the order delivered.'),
    shippingMethod: refd('ShippingMethod', 'How quickly to deliver.'),
    shippingAddress: refd('Address', 'Where to deliver.'),
    reference: nstr('The purchase order or note shown on the invoice.', { maxLength: 35 }),
    deliveryNotes: { maxItems: 4, type: ['null', 'array'], items: { maxLength: 140, type: 'string' }, description: 'Up to four instruction lines for the carrier.' },
    couponCode: nstr('A coupon to apply.'),
  }, ['deliverBy', 'shippingMethod', 'shippingAddress']);
  schemas.CancelOrderRequest = obj('Why an order is being cancelled.', { reason: str('The reason, shown to the customer.', { maxLength: 200 }) }, ['reason']);

  /* ---------- Payments and refunds ---------- */
  schemas.PaymentMethod = {
    required: ['type'], type: 'object', oneOf: [ref('PaymentMethodCard'), ref('PaymentMethodWallet'), ref('PaymentMethodGiftCard')],
    description: 'How the customer paid. The `type` property selects the variant:\n`Card` for credit and debit cards, `Wallet` for PayPal and similar, and `GiftCard` for store gift cards.',
    discriminator: { propertyName: 'type', mapping: { Card: '#/components/schemas/PaymentMethodCard', Wallet: '#/components/schemas/PaymentMethodWallet', GiftCard: '#/components/schemas/PaymentMethodGiftCard' } },
  };
  schemas.PaymentMethodCard = {
    examples: [{ type: 'Card', brand: 'Visa', last4: '4242', expMonth: 8, expYear: 2028 }], required: ['brand', 'last4', 'type'],
    properties: { type: { enum: ['Card'], type: 'string', description: 'Always `Card` for this variant.' }, brand: str('The card network, such as `Visa`.'), last4: { pattern: '^[0-9]{4}$', type: 'string', description: 'The last four digits of the card number.' }, expMonth: int('The expiry month, 1 to 12.', { minimum: 1, maximum: 12 }), expYear: int('The four-digit expiry year.') },
    description: 'A credit or debit card. The full number is never stored.',
  };
  schemas.PaymentMethodWallet = {
    examples: [{ type: 'Wallet', provider: 'PayPal', accountEmail: 'priya.raman@example.com' }], required: ['provider', 'type'],
    properties: { type: { enum: ['Wallet'], type: 'string', description: 'Always `Wallet` for this variant.' }, provider: { enum: ['PayPal', 'ApplePay', 'GooglePay'], type: 'string', description: 'The wallet provider.' }, accountEmail: nstr('The email the wallet account is registered to.', { format: 'email' }) },
    description: 'A digital wallet.',
  };
  schemas.PaymentMethodGiftCard = {
    examples: [{ type: 'GiftCard', last4: '7731', remainingBalance: 35 }], required: ['last4', 'type'],
    properties: { type: { enum: ['GiftCard'], type: 'string', description: 'Always `GiftCard` for this variant.' }, last4: { pattern: '^[A-Z0-9]{4}$', type: 'string', description: 'The last four characters of the card code.' }, remainingBalance: { type: ['null', 'number'], description: 'What is left on the card after this payment.', format: 'decimal' } },
    description: 'A store gift card.',
  };
  schemas.Refund = obj('Money returned to the customer for part or all of a payment.', {
    id: uuid('The refund’s unique ID.'),
    amount: dec('The amount returned, in the payment’s currency.'),
    reason: refd('RefundReason', 'Why the refund was issued.'),
    note: nstr('The agent’s note. Always present for `NotAsDescribed`.'),
    createdBy: refd('ActorReference', 'The agent who issued the refund.'),
    createdAt: stamp('When the refund was issued.'),
  }, ['id', 'amount', 'reason', 'createdBy', 'createdAt']);
  schemas.Payment = obj('A payment against an order.', {
    id: uuid('The payment’s unique ID.'),
    number: str('The human-friendly payment number, such as `PAY-2026-000123`.'),
    order: refd('OrderReference', 'The order being paid.'),
    orderNumber: str('The order number, repeated for pick lists.'),
    status: refd('PaymentStatus', 'Where the payment is in its lifecycle.'),
    method: refd('PaymentMethod', 'How the customer paid. The `type` property tells which variant it is.'),
    amount: dec('The amount authorized, in the order currency.'),
    currency: refd('Currency', 'The currency of the amount.'),
    capturedAmount: dec('The amount taken so far.'),
    refundedAmount: dec('The amount returned so far.'),
    refunds: arr(ref('Refund'), 'The refunds issued, oldest first.'),
    processorReference: nstr('The payment provider’s reference, for their dashboard.'),
    createdAt: stamp('When the payment was started.'),
    capturedAt: nstr('When the money was taken.', { format: 'date-time' }),
    failureReason: nstr('Why the provider declined the payment. Present only when it failed.'),
  }, ['id', 'number', 'order', 'orderNumber', 'status', 'method', 'amount', 'currency', 'capturedAmount', 'refundedAmount', 'refunds', 'createdAt']);
  schemas.CapturePaymentRequest = obj('How much to take from an authorized payment.', { amount: dec('The amount to capture. Defaults to the full authorized amount.', { minimum: 0.01 }) }, []);
  schemas.RefundPaymentRequest = obj('Fields used to return money to the customer.', {
    amount: dec('The amount to refund, up to what is left of the captured amount.', { minimum: 0.01 }),
    reason: refd('RefundReason', 'Why the money is being returned.'),
    note: nstr('A note for the order history. Required for `NotAsDescribed`.', { maxLength: 300 }),
    restock: { type: 'boolean', description: 'Whether returned items go back into available stock.', default: true },
  }, ['amount', 'reason']);

  /* ---------- Shipments ---------- */
  schemas.Shipment = obj('A parcel on its way to a customer.', {
    id: uuid('The shipment’s unique ID.'),
    order: refd('OrderReference', 'The order the parcel belongs to.'),
    carrier: str('The carrier, such as `DHL Express`.'),
    trackingNumber: str('The carrier’s tracking number.'),
    status: refd('ShipmentStatus', 'Where the parcel is.'),
    items: arr(obj('One variant in the parcel.', { sku: str('The variant’s SKU.'), quantity: int('How many units.') }, ['sku', 'quantity']), 'What is in the parcel.'),
    weightGrams: int('The parcel’s weight in grams.'),
    shippedAt: stamp('When the carrier collected it.'),
    estimatedDelivery: date('The carrier’s delivery estimate.'),
    deliveredAt: nstr('When it was delivered. Absent until then.', { format: 'date-time' }),
  }, ['id', 'order', 'carrier', 'trackingNumber', 'status', 'items', 'shippedAt']);
  schemas.CreateShipmentRequest = obj('Fields used to ship all or part of an order.', {
    carrier: { enum: ['DHL Express', 'DPD', 'UPS', 'An Post', 'Royal Mail'], type: 'string', description: 'The carrier that collects the parcel.' },
    items: arr(obj('One variant to ship.', { lineId: str('The order line to ship from.', { format: 'uuid' }), quantity: int('How many units to ship.', { minimum: 1 }) }, ['lineId', 'quantity']), 'The order lines to put in the parcel. Leave out to ship everything that is left.'),
    notifyCustomer: { type: 'boolean', description: 'Whether the customer gets the shipping email.', default: true },
  }, ['carrier']);

  /* ---------- Reviews ---------- */
  schemas.Review = obj('A customer’s review of a product.', {
    id: uuid('The review’s unique ID.'),
    product: refd('ProductReference', 'The product reviewed.'),
    productName: str('The product’s name, repeated for pick lists.'),
    customer: refd('CustomerReference', 'Who wrote the review.'),
    rating: int('Stars, 1 to 5.', { minimum: 1, maximum: 5 }),
    title: str('A short headline.', { maxLength: 80 }),
    body: str('The review text.', { maxLength: 2000 }),
    status: refd('ReviewStatus', 'Where the review is in moderation.'),
    verifiedPurchase: { type: 'boolean', description: 'Whether the customer bought the product.' },
    createdAt: stamp('When the review was written.'),
    moderatedBy: maybe('ActorReference', 'The moderator who decided. Absent while the review is pending.'),
  }, ['id', 'product', 'productName', 'customer', 'rating', 'title', 'body', 'status', 'verifiedPurchase', 'createdAt']);
  schemas.CreateReviewRequest = obj('Fields used to write a review.', {
    productId: withLookup(uuid('The product being reviewed.'), L.product),
    rating: int('Stars, 1 to 5.', { minimum: 1, maximum: 5 }),
    title: str('A short headline.', { maxLength: 80 }),
    body: str('The review text.', { maxLength: 2000 }),
  }, ['productId', 'rating', 'title', 'body']);
  schemas.ModerateReviewRequest = obj('A moderator’s decision.', {
    decision: refd('ModerationDecision', 'Whether to publish or reject the review.'),
    comment: nstr('A note for the author. Required when rejecting.', { maxLength: 300 }),
  }, ['decision']);

  /* ---------- Coupons ---------- */
  const couponCommon = {
    id: uuid('The coupon’s unique ID.'),
    code: { pattern: '^[A-Z0-9]{4,16}$', type: 'string', description: 'What the customer types at checkout, such as `SPRING25`.' },
    description: str('What the coupon is for, in plain words.'),
    status: refd('CouponStatus', 'Whether the coupon can still be redeemed.'),
    startsOn: date('The first day it works.'),
    endsOn: date('The last day it works.'),
    maxRedemptions: int('How many times it can be redeemed in total.', { minimum: 1 }),
    redemptions: int('How many times it has been redeemed so far. The counter lives in Redis.'),
    createdBy: refd('ActorReference', 'Who created the coupon.'),
  };
  const couponRequired = ['id', 'code', 'description', 'status', 'startsOn', 'endsOn', 'maxRedemptions', 'redemptions', 'createdBy', 'type'];
  schemas.Coupon = {
    required: ['type'], type: 'object', oneOf: [ref('CouponPercentage'), ref('CouponFixedAmount')],
    description: 'A discount code. The `type` property selects the variant: `Percentage` coupons take a percentage off the\nbasket, `FixedAmount` coupons take a fixed amount off.',
    discriminator: { propertyName: 'type', mapping: { Percentage: '#/components/schemas/CouponPercentage', FixedAmount: '#/components/schemas/CouponFixedAmount' } },
  };
  schemas.CouponPercentage = {
    examples: [{ type: 'Percentage', id: 'e5f6a7b8-1111-4222-8333-444455556666', code: 'SPRING25', description: '25% off spring knitwear', status: 'Active', startsOn: '2026-11-01', endsOn: '2026-12-31', maxRedemptions: 500, redemptions: 218, createdBy: { email: 'ada.admin@acme.dev', name: 'Ada Admin' }, percentOff: 25, maxDiscount: 60 }],
    required: ['percentOff', ...couponRequired],
    properties: { type: { enum: ['Percentage'], type: 'string', description: 'Always `Percentage` for this variant. It tells the variants of the union apart.' }, percentOff: int('The percentage taken off, 1 to 100.', { minimum: 1, maximum: 100 }), maxDiscount: { type: ['null', 'number'], description: 'The most a single order can save. Absent for no cap.', format: 'decimal' }, ...couponCommon },
    description: 'Takes a percentage off the qualifying lines.',
  };
  schemas.CouponFixedAmount = {
    examples: [{ type: 'FixedAmount', id: 'f6a7b8c9-2222-4333-8444-555566667777', code: 'WELCOME10', description: '€10 off a first order over €50', status: 'Active', startsOn: '2026-01-01', endsOn: '2026-12-31', maxRedemptions: 5000, redemptions: 1904, createdBy: { email: 'ada.admin@acme.dev', name: 'Ada Admin' }, amountOff: { value: 10, currency: 'EUR' }, minimumSubtotal: 50 }],
    required: ['amountOff', ...couponRequired],
    properties: { type: { enum: ['FixedAmount'], type: 'string', description: 'Always `FixedAmount` for this variant. It tells the variants of the union apart.' }, amountOff: refd('MoneyAmount', 'The amount taken off the basket.'), minimumSubtotal: { type: ['null', 'number'], description: 'The basket subtotal needed before the coupon works.', format: 'decimal' }, ...couponCommon },
    description: 'Takes a fixed amount off the basket.',
  };
  schemas.CreateCouponRequest = obj('Fields used to create a coupon.', {
    code: { pattern: '^[A-Z0-9]{4,16}$', type: 'string', description: 'What the customer types at checkout. Letters and digits only.' },
    description: str('What the coupon is for.', { maxLength: 120 }),
    type: refd('CouponType', 'Whether the coupon takes a percentage or a fixed amount off.'),
    percentOff: { type: ['null', 'integer'], description: 'The percentage off, 1 to 100. Required for `Percentage` coupons.', format: 'int32', minimum: 1, maximum: 100 },
    amountOff: { type: ['null', 'number'], description: 'The amount off, in `currency`. Required for `FixedAmount` coupons.', format: 'decimal' },
    currency: { oneOf: [{ type: 'null' }, refd('Currency', 'The currency of `amountOff`.')] },
    startsOn: date('The first day it works.'),
    endsOn: date('The last day it works.'),
    maxRedemptions: int('How many times it can be redeemed in total.', { minimum: 1 }),
  }, ['code', 'description', 'type', 'startsOn', 'endsOn', 'maxRedemptions']);
  schemas.RedeemCouponRequest = obj('The order a coupon is being redeemed against.', {
    orderId: withLookup(uuid('The order to apply the coupon to. It must still be pending.'), L.order),
  }, ['orderId']);
  schemas.CouponRedemption = obj('The result of redeeming a coupon.', {
    code: str('The coupon redeemed.'),
    orderNumber: str('The order it was applied to.'),
    discount: dec('How much it took off.'),
    currency: refd('Currency', 'The currency of the discount.'),
    redemptions: int('The coupon’s redemption count after this one.'),
    remaining: int('How many redemptions are left.'),
  }, ['code', 'orderNumber', 'discount', 'currency', 'redemptions', 'remaining']);

  /* ---------- Users, roles and sign-in ---------- */
  schemas.User = obj('A person who can sign in to the store’s back office or storefront.', {
    id: uuid('The user’s unique ID.'),
    email: str('The sign-in email address.', { format: 'email' }),
    name: str('The display name.'),
    role: refd('RoleName', 'What the user may do.'),
    active: { type: 'boolean', description: 'Whether the user can sign in.' },
    lastSignInAt: nstr('When the user last signed in.', { format: 'date-time' }),
  }, ['id', 'email', 'name', 'role', 'active']);
  schemas.ChangeRoleRequest = obj('The role to give a user.', { role: refd('RoleName', 'The new role.') }, ['role']);
  schemas.Role = obj('A role and what it allows.', {
    name: refd('RoleName', 'The role’s name, as it appears on users and in security requirements.'),
    description: str('What the role is for.'),
    permissions: arr(str('One kind of action the role allows.'), 'The kinds of action the role allows, in plain words.'),
    userCount: int('How many users currently hold the role.'),
  }, ['name', 'description', 'permissions', 'userCount'], {
    name: 'support', description: 'Works customer orders: places them on a customer’s behalf, ships, refunds and moderates reviews.',
    permissions: ['Create, revise and cancel orders', 'Ship orders and issue refunds', 'Publish or reject reviews'], userCount: 4,
  });
  schemas.Persona = obj('Identity and role displayed in the workbench.', {
    email: str('The user’s email address.', { format: 'email' }), name: str('The user’s display name.'), role: str('The user’s role: `admin`, `support` or `customer`.'),
  }, ['email', 'name', 'role'], { email: 'ada.admin@acme.dev', name: 'Ada Admin', role: 'admin' });
  schemas.LoginRequest = obj('Credentials for the demo’s cookie sign-in.', {
    email: str('The user’s email address.', { format: 'email' }), password: str('The user’s password.', { format: 'password', writeOnly: true }),
  }, ['email', 'password'], { email: 'ada.admin@acme.dev', password: 'Demo123!' });
  schemas.ProblemDetails = {
    type: 'object',
    properties: {
      type: nstr('A URI that identifies the kind of problem.'), title: nstr('A short summary of the problem. It does not change between occurrences.'),
      status: { type: ['null', 'integer'], description: 'The HTTP status code of the response.', format: 'int32' },
      detail: nstr('An explanation of this particular occurrence, written for the person using the API.'), instance: nstr('A URI that identifies this occurrence of the problem.'),
    },
    description: 'An error in the RFC 9457 problem-details format.',
  };
  schemas.HttpValidationProblemDetails = {
    type: 'object',
    properties: {
      ...schemas.ProblemDetails.properties,
      errors: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'The validation failures: each key is the JSON name of a field (nested as `address.city`), each value the messages for it.' },
    },
    description: 'A request-validation error: problem details plus the failures per field.',
  };
  for (const name of ['Customer', 'Product', 'ProductVariant', 'StockLevel', 'StockMovement', 'Order', 'Payment', 'Shipment', 'Review', 'Coupon', 'User']) {
    schemas[`PagedListOf${name}`] = {
      required: ['items', 'page', 'pageSize', 'totalItems', 'totalPages'], type: 'object',
      properties: {
        items: arr(ref(name), 'The items on this page, in the requested sort order.'), page: int('The 1-based number of this page.'),
        pageSize: int('The maximum number of items on a page, as requested.'), totalItems: int('The number of items that match the filters across all pages.'),
        totalPages: int('The number of pages needed to list every matching item (zero when nothing matches).'),
      },
      description: `One page of ${name} items, with the paging metadata needed to fetch the other pages.`,
    };
  }

  /* ---------- Operations ---------- */
  const paths = {};
  const add = (path, method, operation) => { (paths[path] ||= {})[method] = operation; };
  const list = (path, tag, id, noun, schema, summary, description, parameters, extra = {}) => add(path, 'get', op({
    tag, id, summary, description, parameters: [pageParam, pageSizeParam(noun), ...parameters],
    ok: [[200, json(`A page of ${noun}.`, ref(schema))]], errors: { 400: { ...standard[400](), description: 'A paging, sort or filter value was invalid.' }, 401: standard[401]() }, ...extra,
  }));

  // Authentication
  add('/auth/login', 'post', op({
    tag: 'Authentication', id: 'AuthController.Login', summary: 'Sign in with a password', roles: null,
    description: 'Checks the email and password and starts a session. The browser keeps the session cookie, so later\nrequests are signed in. Every seeded user has the demo password `Demo123!`.\n\nIn development you can skip the password with `AuthController.SwitchPersona`.',
    requestBody: body('The email address and password.', 'LoginRequest'),
    ok: [[200, json('Signed in. The response says who you are.', ref('Persona'))]],
    errors: { 401: { description: 'The email or password is wrong, or the user is deactivated.', content: problem('ProblemDetails', { type: `${RFC}15.5.2`, title: 'Unauthorized', status: 401, detail: 'The email or password is wrong.' }) } },
  }));
  add('/auth/me', 'get', op({
    tag: 'Authentication', id: 'AuthController.Me', summary: 'Get the current user', description: 'Returns the identity and role of the signed-in user. Use it to check which session the browser holds.',
    ok: [[200, json('The signed-in user.', ref('Persona'))]], errors: { 401: standard[401]() },
  }));
  add('/auth/logout', 'post', op({ tag: 'Authentication', id: 'AuthController.Logout', summary: 'Sign out', description: 'Ends the session and clears the session cookie.', roles: null, ok: [[204, { description: 'Signed out.' }]] }));
  add('/auth/personas', 'get', op({
    tag: 'Authentication', id: 'AuthController.Personas', summary: 'List development personas', description: 'Lists the seeded users: a customer, a support agent and a store admin.', roles: null,
    ok: [[200, json('The seeded users.', arr(ref('Persona')))]],
  }));
  add('/auth/personas/{email}', 'post', op({
    tag: 'Authentication', id: 'AuthController.SwitchPersona', summary: 'Switch to a development persona', description: 'Signs in as a seeded user without a password. Available in development only.', roles: null,
    parameters: [{ name: 'email', in: 'path', description: 'The seeded user’s email address, URL-encoded.', required: true, schema: { type: 'string' } }],
    ok: [[200, json('Signed in as that user.', ref('Persona'))]],
    errors: { 404: { description: 'No seeded user has this email address.', content: problem('ProblemDetails', { type: `${RFC}15.5.5`, title: 'Not found', status: 404, detail: 'No seeded user has the email address nobody@acme.dev.' }) } },
  }));

  // Customers
  list('/api/v2/customers', 'Customers', 'CustomersController.List', 'customers', 'PagedListOfCustomer', 'List customers',
    'Returns the store’s customers, sorted by name unless you pass `sort`.\nUse `status=Active` to list the customers who can place orders. Each customer’s order history is on\n`OrdersController.List`, filtered by `customerId`.',
    [query('status', 'Only customers in this status.', ref('CustomerStatus')), query('segment', 'Only customers of this kind.', ref('CustomerSegment')), query('currency', 'Only customers who pay in this currency.', ref('Currency')),
      q('Search text matched against name, email and phone.'),
      sortParam('Defaults to `name`.', { name: 'Name, A to Z', '-name': 'Name, Z to A', spend: 'Lifetime spend, lowest first', '-spend': 'Lifetime spend, highest first', joinedOn: 'Registered, oldest first', '-joinedOn': 'Registered, newest first' })],
    { roles: staff });
  add('/api/v2/customers', 'post', op({
    tag: 'Customers', id: 'CustomersController.Create', summary: 'Register customer', roles: staff,
    description: `Registers a customer. The email address must not belong to another customer. ${staffText}`,
    requestBody: body('The new customer.', 'CreateCustomerRequest'),
    ok: [[201, json('The customer was registered. The `Location` header points to it.', ref('Customer'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin or support role'), 409: standard[409]('Another customer already uses this email address.', 'The email address priya.raman@example.com is already registered.') },
  }));
  add('/api/v2/customers/{id}', 'get', op({
    tag: 'Customers', id: 'CustomersController.Get', summary: 'Get customer', description: 'Returns one customer, with their default address and lifetime spend.',
    parameters: [idParam('id', 'The customer’s ID, from `CustomersController.List`.', L.customer)],
    ok: [[200, json('The customer.', ref('Customer'))]], errors: { 401: standard[401](), 404: standard[404]('customer') },
  }));
  add('/api/v2/customers/{id}', 'put', op({
    tag: 'Customers', id: 'CustomersController.Update', summary: 'Update customer', roles: staff,
    description: `Changes a customer’s name, phone, segment or notes. ${staffText}`,
    parameters: [idParam('id', 'The customer’s ID.', L.customer)], requestBody: body('The values to change.', 'UpdateCustomerRequest'),
    ok: [[200, json('The updated customer.', ref('Customer'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin or support role'), 404: standard[404]('customer'), 409: standard[409]('The customer is closed and cannot be changed.', 'A closed customer cannot be changed.') },
  }));
  add('/api/v2/customers/{id}/deactivate', 'post', op({
    tag: 'Customers', id: 'CustomersController.Deactivate', summary: 'Close customer account', roles: ['admin'],
    description: 'Closes a customer’s account for good. The customer can no longer sign in, and no order may still be open.\nOrder history is kept. Requires the `admin` role.',
    parameters: [idParam('id', 'The customer’s ID.', L.customerActive)],
    ok: [[200, json('The closed customer.', ref('Customer'))]],
    errors: { 401: standard[401](), 403: standard[403]('admin role'), 404: standard[404]('customer'), 409: standard[409]('The account is already closed.', 'The customer is already closed.'), 422: standard[422]('The customer still has open orders.', 'Cancel or deliver the 2 open orders before closing the account.') },
  }));

  // Products and variants
  list('/api/v2/products', 'Products', 'ProductsController.List', 'products', 'PagedListOfProduct', 'List products',
    'Returns the catalog, sorted by name unless you pass `sort`. Each product carries its variants.',
    [query('status', 'Only products in this status.', ref('ProductStatus')), query('category', 'Only products on this shelf.', ref('ProductCategory')),
      query('originCountry', 'Only products made in this country.', countryProp('An ISO 3166-1 alpha-2 country code.')),
      query('minPrice', 'Only products with a variant priced at least this much.', { minimum: 0, type: 'number', format: 'double' }),
      q('Search text matched against name, SKU and brand.'),
      sortParam('Defaults to `name`.', { name: 'Name, A to Z', '-name': 'Name, Z to A', rating: 'Rating, lowest first', '-rating': 'Rating, highest first', createdAt: 'Added, oldest first', '-createdAt': 'Added, newest first' })]);
  add('/api/v2/products', 'post', op({
    tag: 'Products', id: 'ProductsController.Create', summary: 'Add product', roles: ['admin'],
    description: 'Adds a product to the catalog. Add its variants afterwards. The `fulfilment` property decides how the\nproduct is delivered; its `type` selects one of three shapes. Requires the `admin` role.',
    requestBody: body('The new product.', 'CreateProductRequest'),
    ok: [[201, json('The product was added. The `Location` header points to it.', ref('Product'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin role'), 409: standard[409]('The SKU is already used by another product.', 'The SKU APP-MCS is already used by Merino Crew Sweater.') },
  }));
  add('/api/v2/products/{id}', 'get', op({
    tag: 'Products', id: 'ProductsController.Get', summary: 'Get product', description: 'Returns one product with its variants, fulfilment details and average rating.',
    parameters: [idParam('id', 'The product’s ID.', L.product)], ok: [[200, json('The product.', ref('Product'))]], errors: { 401: standard[401](), 404: standard[404]('product') },
  }));
  add('/api/v2/products/{id}', 'put', op({
    tag: 'Products', id: 'ProductsController.Update', summary: 'Update product', roles: ['admin'], description: 'Changes a product’s name, shelf, brand or supplier contact. Requires the `admin` role.',
    parameters: [idParam('id', 'The product’s ID.', L.product)], requestBody: body('The values to change.', 'UpdateProductRequest'),
    ok: [[200, json('The updated product.', ref('Product'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin role'), 404: standard[404]('product'), 409: standard[409]('The product is archived and cannot be changed.', 'An archived product cannot be changed.') },
  }));
  add('/api/v2/products/{id}', 'delete', op({
    tag: 'Products', id: 'ProductsController.Archive', summary: 'Archive product', roles: ['admin'],
    description: 'Takes a product off sale. Products are archived, never deleted, so order history keeps working.\nRequires the `admin` role.',
    parameters: [idParam('id', 'The product’s ID.', L.product)], ok: [[204, { description: 'The product was archived.' }]],
    errors: { 401: standard[401](), 403: standard[403]('admin role'), 404: standard[404]('product'), 409: standard[409]('The product is already archived.', 'The product is already archived.') },
  }));
  list('/api/v2/variants', 'Products', 'ProductsController.ListVariants', 'variants', 'PagedListOfProductVariant', 'List variants',
    'Returns every purchasable variant across the catalog, sorted by name. Use `productId` to list one product’s variants.',
    [query('productId', 'Only variants of this product.', withLookup({ type: 'string', format: 'uuid' }, L.product)), query('active', 'Only variants that can (or cannot) be ordered.', { type: 'boolean' }), q('Search text matched against name and SKU.'),
      sortParam('Defaults to `name`.', { name: 'Name, A to Z', '-name': 'Name, Z to A', price: 'Price, lowest first', '-price': 'Price, highest first' })]);

  // Inventory
  list('/api/v2/inventory', 'Inventory', 'InventoryController.List', 'stock levels', 'PagedListOfStockLevel', 'List stock levels',
    'Returns the stock of every variant: units on hand, reserved for paid orders, and still available to sell.',
    [query('lowStock', 'Only variants at or below their reorder point.', { type: 'boolean' }), query('productId', 'Only variants of this product.', withLookup({ type: 'string', format: 'uuid' }, L.product)), q('Search text matched against name and SKU.')]);
  add('/api/v2/inventory/{variantId}', 'get', op({
    tag: 'Inventory', id: 'InventoryController.Get', summary: 'Get stock level', description: 'Returns the on-hand, reserved and available units of one variant.',
    parameters: [idParam('variantId', 'The variant’s ID.', L.variant)], ok: [[200, json('The stock level.', ref('StockLevel'))]], errors: { 401: standard[401](), 404: standard[404]('variant') },
  }));
  add('/api/v2/inventory/{variantId}/movements', 'get', op({
    tag: 'Inventory', id: 'InventoryController.Movements', summary: 'List stock movements', description: 'Returns every change to a variant’s stock, newest first: receipts, sales, returns and adjustments.',
    parameters: [idParam('variantId', 'The variant’s ID.', L.variant), pageParam, pageSizeParam('movements'), query('from', 'Only movements on or after this date.', { type: 'string', format: 'date' }), query('to', 'Only movements on or before this date.', { type: 'string', format: 'date' })],
    ok: [[200, json('A page of stock movements.', ref('PagedListOfStockMovement'))]], errors: { 400: standard[400](), 401: standard[401](), 404: standard[404]('variant') },
  }));
  add('/api/v2/variants/{id}/stock', 'get', op({
    tag: 'Inventory', id: 'InventoryController.LegacyStock', summary: 'Get available stock',
    description: '**Deprecated.** Returns only the available units. Use `InventoryController.Get`, which also reports the\non-hand and reserved units, or `InventoryController.List` for every variant at once.\nThe response carries a `Deprecation` header, a `Sunset` header with the removal date and a `Link` to its replacement.',
    parameters: [idParam('id', 'The variant’s ID.', L.variant)],
    ok: [[200, json('The variant’s available units.', ref('LegacyStock'))]], errors: { 401: standard[401](), 404: standard[404]('variant') },
    extra: {
      deprecated: true,
      'x-replaced-by': [{ operationId: 'InventoryController.Get', parameters: { variantId: '$request.path.id' }, description: 'The same variant, with the on-hand and reserved units too.' }, { operationId: 'InventoryController.List', description: 'Every variant’s stock in one call.' }],
      'x-sunset': '2027-06-30',
    },
  }));

  // Carts
  add('/api/v2/carts', 'post', op({
    tag: 'Carts', id: 'CartsController.Create', summary: 'Start cart', description: 'Starts a cart with its first lines. Prices are read from the catalog when each line is added.',
    requestBody: body('The cart to start.', 'CreateCartRequest'), ok: [[201, json('The cart was started.', ref('Cart'))]], errors: { 400: standard[400](), 401: standard[401]() },
  }));
  add('/api/v2/carts/{id}', 'get', op({
    tag: 'Carts', id: 'CartsController.Get', summary: 'Get cart', description: 'Returns a cart with its lines and subtotal. Carts expire after 14 days without a change.',
    parameters: [idParam('id', 'The cart’s ID.', L.cart)], ok: [[200, json('The cart.', ref('Cart'))]], errors: { 401: standard[401](), 404: standard[404]('cart') },
  }));
  add('/api/v2/carts/{id}/quote', 'post', op({
    tag: 'Carts', id: 'CartsController.Quote', summary: 'Price cart', roles: [],
    description: 'Prices a cart with shipping, coupon and tax, and holds the quote in Redis until it expires, so checkout can\nhonour it. Nothing is written to the database. Redis cannot be rolled back, so this operation is marked\n`preview: false`: Preview is switched off and Send asks before it runs.',
    parameters: [idParam('id', 'The cart to price.', L.cart)], requestBody: body('What to price the cart with.', 'CartQuoteRequest'),
    ok: [[200, json('The quote.', ref('CartQuote'))]],
    errors: { 400: standard[400](), 401: standard[401](), 404: standard[404]('cart'), 422: standard[422]('The coupon is not valid for this cart.', 'Coupon SPRING25 expired on 2026-10-31.') },
    extra: { 'x-sendproof-preview': false, 'x-sendproof-preview-reason': 'Writes the quote to Redis, which cannot be rolled back.' },
  }));

  // Orders
  list('/api/v2/orders', 'Orders', 'OrdersController.List', 'orders', 'PagedListOfOrder', 'List orders',
    'Returns orders, newest first unless you pass `sort`. Filter by status, customer, date or amount, or search by number or reference.',
    [query('status', 'Only orders in this status.', ref('OrderStatus')), query('currency', 'Only orders in this currency.', ref('Currency')), query('shippingMethod', 'Only orders delivered this way.', ref('ShippingMethod')),
      query('customerId', 'Only orders placed by this customer.', withLookup({ type: 'string', format: 'uuid' }, L.customer)),
      query('deliverByFrom', 'Only orders to deliver on or after this date.', { type: 'string', format: 'date' }), query('deliverByTo', 'Only orders to deliver on or before this date.', { type: 'string', format: 'date' }),
      query('minAmount', 'Only orders of at least this amount.', { minimum: 0, type: 'number', format: 'double' }), query('maxAmount', 'Only orders of at most this amount.', { minimum: 0, type: 'number', format: 'double' }),
      query('reference', 'Only orders whose reference contains this text.', { type: 'string' }),
      q('Search text matched against number, reference, external ID and customer name.'),
      sortParam('Defaults to `-createdAt`.', { deliverBy: 'Delivery date, earliest first', '-deliverBy': 'Delivery date, latest first', amount: 'Total, lowest first', '-amount': 'Total, highest first', createdAt: 'Created, oldest first', '-createdAt': 'Created, newest first', number: 'Number, ascending', '-number': 'Number, descending' })]);
  add('/api/v2/orders', 'post', op({
    tag: 'Orders', id: 'OrdersController.Create', summary: 'Create order', roles: staff,
    description: 'Creates a **pending** order on a customer’s behalf and reserves its stock, so the variant’s available units\ndrop immediately. The order is not picked until its payment has been captured with\n`PaymentsController.Capture`.\n\nSend an `Idempotency-Key` header to make retries safe: repeating the same request with the same key returns\nthe original order with status 200, and reusing the key with a different body fails with 409.\n\n' + staffText + ' Preview shows the database changes, the notification and\nthe SQL without keeping any of it.',
    parameters: [{ name: 'Idempotency-Key', in: 'header', description: 'A unique key for this request, up to 128 characters. Generate a UUID for each new order; repeating the request with the same key returns the original order instead of ordering twice.', schema: { type: 'string' } }],
    requestBody: body('The order to place.', 'CreateOrderRequest'),
    ok: [[200, json('The idempotency key was used before with the same request; the original order is returned.', ref('Order'))], [201, json('The pending order was created. The `Location` header points to it.', ref('Order'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin or support role'), 409: standard[409]('The idempotency key was already used for a different request.', 'The Idempotency-Key 5c0e8f3a was already used with a different request body.') },
  }));
  add('/api/v2/orders/{id}', 'get', op({
    tag: 'Orders', id: 'OrdersController.Get', summary: 'Get order', description: 'Returns one order with its lines, delivery details and status.',
    parameters: [idParam('id', 'The order’s ID.', L.order)], ok: [[200, json('The order.', ref('Order'))]], errors: { 401: standard[401](), 404: standard[404]('order') },
  }));
  add('/api/v2/orders/{id}', 'put', op({
    tag: 'Orders', id: 'OrdersController.Update', summary: 'Update unshipped order', roles: staff,
    description: `Changes the delivery date, method, address or notes of an order that has not shipped. ${staffText}`,
    parameters: [idParam('id', 'The order’s ID.', L.order)], requestBody: body('The new values. Every field is replaced.', 'UpdateOrderRequest'),
    ok: [[200, json('The updated order.', ref('Order'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin or support role'), 404: standard[404]('order'), 409: standard[409]('The order has already shipped.', 'Only orders that have not shipped can be changed, and this one is Shipped.') },
  }));
  add('/api/v2/orders/{id}/cancel', 'post', op({
    tag: 'Orders', id: 'OrdersController.Cancel', summary: 'Cancel order', roles: staff,
    description: `Cancels an order that has not shipped, releases its reserved stock and voids or refunds its payment. ${staffText}`,
    parameters: [idParam('id', 'The order’s ID.', L.order)], requestBody: body('Why the order is cancelled.', 'CancelOrderRequest'),
    ok: [[200, json('The cancelled order.', ref('Order'))]],
    errors: { 401: standard[401](), 403: standard[403]('admin or support role'), 404: standard[404]('order'), 409: standard[409]('The order has already shipped or was cancelled.', 'Only orders that have not shipped can be cancelled, and this one is Delivered.') },
  }));

  // Payments and refunds
  list('/api/v2/payments', 'Payments', 'PaymentsController.List', 'payments', 'PagedListOfPayment', 'List payments',
    'Returns payments, newest first. Each payment lists the refunds issued against it.',
    [query('status', 'Only payments in this status.', ref('PaymentStatus')), query('currency', 'Only payments in this currency.', ref('Currency')),
      query('orderId', 'Only payments for this order.', withLookup({ type: 'string', format: 'uuid' }, L.order)), q('Search text matched against payment number, order number and provider reference.')], { extra: { security: [{ cookieAuth: ['admin'] }, { cookieAuth: ['support'] }] } });
  add('/api/v2/payments/{id}', 'get', op({
    tag: 'Payments', id: 'PaymentsController.Get', summary: 'Get payment', roles: staff, description: `Returns one payment with its method and refunds. ${staffText}`,
    parameters: [idParam('id', 'The payment’s ID.', L.payment)], ok: [[200, json('The payment.', ref('Payment'))]], errors: { 401: standard[401](), 403: standard[403]('admin or support role'), 404: standard[404]('payment') },
  }));
  add('/api/v2/payments/{id}/capture', 'post', op({
    tag: 'Payments', id: 'PaymentsController.Capture', summary: 'Capture payment', roles: staff,
    description: `Takes the money from an authorized payment, in full or in part. The order moves to Paid. ${staffText}`,
    parameters: [idParam('id', 'The payment’s ID.', L.payment)], requestBody: body('How much to capture.', 'CapturePaymentRequest'),
    ok: [[200, json('The captured payment.', ref('Payment'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin or support role'), 404: standard[404]('payment'), 409: standard[409]('The payment is not authorized.', 'Only authorized payments can be captured, and this one is Failed.') },
  }));
  add('/api/v2/payments/{id}/refunds', 'post', op({
    tag: 'Payments', id: 'PaymentsController.Refund', summary: 'Refund payment', roles: staff,
    description: `Returns money to the customer for all or part of a captured payment, and puts returned items back in stock unless \`restock\` is false. ${staffText}`,
    parameters: [idParam('id', 'The payment’s ID.', L.payment)], requestBody: body('The refund to issue.', 'RefundPaymentRequest'),
    ok: [[201, json('The refund was issued.', ref('Refund'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin or support role'), 404: standard[404]('payment'), 422: standard[422]('The refund is more than is left to refund.', 'Only 12.50 of this payment can still be refunded.') },
  }));

  // Shipments
  list('/api/v2/shipments', 'Shipments', 'ShipmentsController.List', 'shipments', 'PagedListOfShipment', 'List shipments',
    'Returns parcels, newest first. Use `status=Exception` to find parcels the carrier could not deliver.',
    [query('status', 'Only parcels in this status.', ref('ShipmentStatus')), query('orderId', 'Only parcels of this order.', withLookup({ type: 'string', format: 'uuid' }, L.order)), q('Search text matched against tracking number and order number.')]);
  add('/api/v2/shipments/{id}', 'get', op({
    tag: 'Shipments', id: 'ShipmentsController.Get', summary: 'Get shipment', description: 'Returns one parcel with its contents and tracking status.',
    parameters: [idParam('id', 'The shipment’s ID.', L.shipment)], ok: [[200, json('The shipment.', ref('Shipment'))]], errors: { 401: standard[401](), 404: standard[404]('shipment') },
  }));
  add('/api/v2/orders/{orderId}/shipments', 'post', op({
    tag: 'Shipments', id: 'ShipmentsController.Create', summary: 'Ship order', roles: staff,
    description: `Books a carrier, creates the parcel and takes its units out of stock. The order moves to Shipped once every line has shipped. The customer gets a shipping email unless \`notifyCustomer\` is false. ${staffText}`,
    parameters: [idParam('orderId', 'The order to ship.', L.order)], requestBody: body('The parcel to create.', 'CreateShipmentRequest'),
    ok: [[201, json('The parcel was created. The `Location` header points to it.', ref('Shipment'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin or support role'), 404: standard[404]('order'), 409: standard[409]('The order is not paid or is already fully shipped.', 'Only paid orders can be shipped, and this one is Pending.') },
  }));

  // Reviews
  list('/api/v2/reviews', 'Reviews', 'ReviewsController.List', 'reviews', 'PagedListOfReview', 'List reviews',
    'Returns reviews, newest first. Use `status=Pending` for the moderation queue. Reviews are stored as MongoDB documents.',
    [query('status', 'Only reviews in this status.', ref('ReviewStatus')), query('productId', 'Only reviews of this product.', withLookup({ type: 'string', format: 'uuid' }, L.product)),
      query('minRating', 'Only reviews with at least this many stars.', { minimum: 1, maximum: 5, type: 'integer', format: 'int32' }), q('Search text matched against title and body.')]);
  add('/api/v2/reviews', 'post', op({
    tag: 'Reviews', id: 'ReviewsController.Create', summary: 'Write review', description: 'Writes a review as the signed-in customer. It waits in the moderation queue until a moderator publishes it.',
    requestBody: body('The review.', 'CreateReviewRequest'), ok: [[201, json('The review was saved as Pending.', ref('Review'))]],
    errors: { 400: standard[400](), 401: standard[401](), 409: standard[409]('The customer already reviewed this product.', 'You have already reviewed Merino Crew Sweater.') },
  }));
  add('/api/v2/reviews/{id}/moderate', 'post', op({
    tag: 'Reviews', id: 'ReviewsController.Moderate', summary: 'Moderate review', roles: staff,
    description: `Publishes or rejects a pending review. Nobody can moderate their own review. ${staffText}`,
    parameters: [idParam('id', 'The review’s ID.', L.review)], requestBody: body('The decision.', 'ModerateReviewRequest'),
    ok: [[200, json('The moderated review.', ref('Review'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin or support role'), 404: standard[404]('review'), 409: standard[409]('The review was already moderated.', 'Only pending reviews can be moderated, and this one is Published.') },
  }));

  // Coupons
  list('/api/v2/coupons', 'Coupons', 'CouponsController.List', 'coupons', 'PagedListOfCoupon', 'List coupons', 'Returns coupons, newest first, with how many times each has been redeemed.',
    [query('status', 'Only coupons in this status.', ref('CouponStatus')), query('type', 'Only coupons of this type.', ref('CouponType')), q('Search text matched against code and description.')], { extra: { security: [{ cookieAuth: ['admin'] }, { cookieAuth: ['support'] }] } });
  add('/api/v2/coupons', 'post', op({
    tag: 'Coupons', id: 'CouponsController.Create', summary: 'Create coupon', roles: ['admin'],
    description: 'Creates a coupon. `Percentage` coupons need `percentOff`; `FixedAmount` coupons need `amountOff` and `currency`. Requires the `admin` role.',
    requestBody: body('The new coupon.', 'CreateCouponRequest'), ok: [[201, json('The coupon was created.', ref('Coupon'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin role'), 409: standard[409]('The code is already used by another coupon.', 'The code SPRING25 is already used.') },
  }));
  add('/api/v2/coupons/{code}', 'get', op({
    tag: 'Coupons', id: 'CouponsController.Get', summary: 'Get coupon', description: 'Returns one coupon by its code. The `type` property tells which variant it is.',
    parameters: [{ name: 'code', in: 'path', description: 'The coupon code.', required: true, schema: withLookup({ type: 'string' }, lookup('/api/v2/coupons?pageSize=100', 'code', 'description', 'status')) }],
    ok: [[200, json('The coupon.', ref('Coupon'))]], errors: { 401: standard[401](), 404: standard[404]('coupon') },
  }));
  add('/api/v2/coupons/{code}/redeem', 'post', op({
    tag: 'Coupons', id: 'CouponsController.Redeem', summary: 'Redeem coupon', roles: staff,
    description: 'Applies a coupon to a pending order and counts the redemption. The counter is a Redis `INCRBY`, which cannot\nbe rolled back, so Sendproof’s write guard stops a Preview of this operation with a 409 before the command leaves\nthe API. Send runs it for real and asks first. ' + staffText,
    parameters: [{ name: 'code', in: 'path', description: 'The coupon code.', required: true, schema: { type: 'string' } }], requestBody: body('The order to apply the coupon to.', 'RedeemCouponRequest'),
    ok: [[200, json('The coupon was applied.', ref('CouponRedemption'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin or support role'), 404: standard[404]('coupon'), 409: standard[409]('The coupon has no redemptions left, or the order already has a coupon.', 'Coupon SPRING25 has no redemptions left.') },
  }));

  // Users and roles
  list('/api/v2/users', 'Users and roles', 'UsersController.List', 'users', 'PagedListOfUser', 'List users', 'Returns the people who can sign in, sorted by name.',
    [query('role', 'Only users with this role.', ref('RoleName')), query('active', 'Only users who can (or cannot) sign in.', { type: 'boolean' }), q('Search text matched against name and email.')], { extra: { security: [{ cookieAuth: ['admin'] }] } });
  add('/api/v2/users/{id}', 'get', op({
    tag: 'Users and roles', id: 'UsersController.Get', summary: 'Get user', roles: ['admin'], description: 'Returns one user. Requires the `admin` role.',
    parameters: [idParam('id', 'The user’s ID.', L.user)], ok: [[200, json('The user.', ref('User'))]], errors: { 401: standard[401](), 403: standard[403]('admin role'), 404: standard[404]('user') },
  }));
  add('/api/v2/users/{id}/role', 'put', op({
    tag: 'Users and roles', id: 'UsersController.ChangeRole', summary: 'Change user role', roles: ['admin'],
    description: 'Gives a user another role. The last admin cannot be demoted. Requires the `admin` role.',
    parameters: [idParam('id', 'The user’s ID.', L.user)], requestBody: body('The new role.', 'ChangeRoleRequest'), ok: [[200, json('The updated user.', ref('User'))]],
    errors: { 400: standard[400](), 401: standard[401](), 403: standard[403]('admin role'), 404: standard[404]('user'), 422: standard[422]('The user is the last admin.', 'Make another user an admin before changing this role.') },
  }));
  add('/api/v2/roles', 'get', op({
    tag: 'Users and roles', id: 'UsersController.Roles', summary: 'List roles', description: 'Returns the roles a user can hold, what each allows and how many users hold it. Change a user’s role with `UsersController.ChangeRole`.',
    ok: [[200, json('The roles.', arr(ref('Role')))]], errors: { 401: standard[401]() },
  }));

  // Path order: deprecated first, then roles and sign-in, then the resources, as the sidebar groups by tag.
  const first = ['/api/v2/variants/{id}/stock', '/api/v2/roles'];
  const sorted = {};
  for (const key of [...first, ...Object.keys(paths)]) if (paths[key] && !sorted[key]) sorted[key] = paths[key];

  window.TB_SPEC = {
    openapi: '3.1.1',
    info: {
      title: 'Acme Store API',
      description: 'The **Acme Store API** runs an online store: the catalog of products and variants, stock, customers, carts and price quotes, orders, payments and refunds, shipments, reviews and coupons. Storefront, mobile app and back-office tools all call it.\n\n## An order in one minute\n\nAn order is created as `Pending`, which immediately **reserves** the stock of every line. Capturing its payment moves it to `Paid`; the warehouse then picks it (`Processing`), packs it (`Packed`) and hands it to a carrier (`Shipped`), and it ends as `Delivered`. A support agent can cancel an order that has not shipped, which releases the stock, and refund any captured payment, in full or in part.\n\n## Conventions\n\n- **Lists** are paged: pass `page` (from 1) and `pageSize` (1 to 100, default 25). Every list returns `{ items, page, pageSize, totalItems, totalPages }`. Lists can be filtered, searched with `q` and sorted with `sort`; a leading `-` reverses the order, as in `-amount`.\n- **Errors** follow [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details. Invalid input is a `400` with an `errors` object keyed by field; business rules are `409` (the state does not allow it) or `422` (the request is understood but not allowed).\n- **Money** is a decimal with at most two fraction digits (none for JPY). **Dates** are ISO 8601; times are UTC.\n- **Idempotency:** send an `Idempotency-Key` header when creating an order, so a retry cannot order twice.\n\n## Signing in\n\nEverything except sign-in needs a session cookie. Sign in with `AuthController.Login` using any seeded user and the password `Demo123!`, or in development pick a persona with `AuthController.SwitchPersona`. Roles decide what you may do:\n\n| Role | Can |\n| --- | --- |\n| `admin` | Everything, including the catalog, coupons and user roles |\n| `support` | Place, ship, cancel and refund orders, and moderate reviews |\n| `customer` | Read the catalog, manage their own cart and write reviews |\n\n## About this example\n\nThis is a disposable example for Sendproof, with seeded data that resets when you delete its database. **Preview** runs an operation for real and rolls the database back, showing the changes, notifications and SQL it would cause; **Send** commits them. Carts and coupon counters live in Redis and reviews and order events in MongoDB, neither of which can be rolled back by a Preview. No email, payment or carrier is ever contacted.',
      contact: { name: 'Acme Store Engineering', url: 'https://example.com/store', email: 'store-ops@acme.dev' },
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT', identifier: 'MIT' },
      version: '2.0.0',
    },
    servers: [{ url: 'http://127.0.0.1:5189/' }],
    paths: sorted,
    components: {
      schemas,
      securitySchemes: { cookieAuth: { type: 'apiKey', description: 'Sign in with a password or a development persona. The browser keeps the session cookie. Operations list the roles they accept as scopes.', name: '.AspNetCore.Cookies', in: 'cookie' } },
    },
    tags: [
      { name: 'Authentication', description: 'Sign in, sign out and switch between the seeded development personas. Sessions use a cookie.' },
      { name: 'Customers', description: 'The people and companies that buy from the store: register, read, update and close them.' },
      { name: 'Products', description: 'The catalog: products, their variants (size, colour) and how each one is fulfilled. Products are archived, never deleted.' },
      { name: 'Inventory', description: 'Stock per variant: units on hand, reserved for paid orders and available to sell, and every movement behind them.' },
      { name: 'Carts', description: 'Baskets before checkout, and price quotes held in Redis until they expire.' },
      { name: 'Orders', description: 'Create, revise and cancel orders. Orders reserve stock on creation and move through payment, picking and shipping.' },
      { name: 'Payments', description: 'Card, wallet and gift-card payments against orders: capture the money and refund it, in full or in part.' },
      { name: 'Shipments', description: 'Parcels handed to carriers, with their contents and tracking status.' },
      { name: 'Reviews', description: 'Customer reviews of products, held for moderation before they are published. Stored as MongoDB documents.' },
      { name: 'Coupons', description: 'Percentage and fixed-amount discount codes, and their redemption counters.' },
      { name: 'Users and roles', description: 'The people who can sign in, the roles they hold and what each role allows. Admins change roles.' },
    ],
    externalDocs: { description: 'Sendproof, the workbench that serves this API', url: 'https://example.com/sendproof' },
  };

  /* ---------- Sample responses ---------- */
  // Deterministic, so every screenshot shows the same data. "Today" in the mocks is 2026-11-20.
  const TODAY = Date.UTC(2026, 10, 20, 14, 2, 11);
  const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
  const day = ms => iso(ms).slice(0, 10);
  const DAY = 86400000;
  let seed = 20261120;
  /** A small linear-congruential generator, so the data never changes between renders. */
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = list => list[Math.floor(rand() * list.length)];
  const hex = (n, width) => (n >>> 0).toString(16).padStart(width, '0').slice(-width);
  /** A stable UUID from a namespace and an index. */
  const id = (space, n) => `${hex(0x5a000000 + space * 4099 + n * 97, 8)}-${hex(n * 131 + space, 4)}-4${hex(space * 17 + n, 3)}-8${hex(n * 7 + space, 3)}-${hex(space * 100003 + n * 7919, 12)}`;

  // Customers: name, country, currency, segment, status, lifetime spend, orders, joined, city.
  const customerRows = [
    ['Amelia Hartley', 'GB', 'GBP', 'Individual', 'Active', 2140.3, 14, '2023-02-11', 'Bristol'], ['Brightside Interiors BV', 'NL', 'EUR', 'Business', 'Active', 18420, 37, '2022-06-30', 'Utrecht'],
    ['Bruno Ferreira', 'PT', 'EUR', 'Individual', 'Active', 389.9, 3, '2025-04-02', 'Porto'], ['Chloé Lambert', 'FR', 'EUR', 'Student', 'Active', 214.5, 4, '2025-09-14', 'Lyon'],
    ['Daniel Okafor', 'IE', 'EUR', 'Individual', 'Active', 1284.7, 9, '2024-03-18', 'Cork'], ['Elena Rossi', 'IT', 'EUR', 'Individual', 'Suspended', 702.1, 6, '2024-01-22', 'Bologna'],
    ['Felix Brandt', 'DE', 'EUR', 'Individual', 'Active', 956, 8, '2023-11-09', 'Hamburg'], ['Grace O’Neill', 'IE', 'EUR', 'Staff', 'Active', 330.4, 5, '2024-07-01', 'Dublin'],
    ['Harbour Café Ltd', 'IE', 'EUR', 'Business', 'Active', 6215.8, 22, '2023-05-16', 'Galway'], ['Hiroshi Tanaka', 'JP', 'JPY', 'Individual', 'Active', 148200, 7, '2024-10-03', 'Osaka'],
    ['Ingrid Larsen', 'NO', 'NOK', 'Individual', 'Active', 8420, 5, '2025-01-27', 'Bergen'], ['Jonas Svensson', 'SE', 'SEK', 'Individual', 'Active', 6310, 4, '2025-02-19', 'Gothenburg'],
    ['Katarzyna Nowak', 'PL', 'PLN', 'Individual', 'Active', 2890, 6, '2024-12-05', 'Kraków'], ['Liam Walsh', 'IE', 'EUR', 'Individual', 'Closed', 120, 1, '2023-08-30', 'Limerick'],
    ['Maya Patel', 'US', 'USD', 'Individual', 'Active', 1750.2, 11, '2023-09-12', 'Austin'], ['Nina Johansson', 'SE', 'SEK', 'Student', 'Active', 1920, 3, '2025-06-08', 'Malmö'],
    ['Northfield Outfitters', 'GB', 'GBP', 'Wholesale', 'Active', 52480.75, 64, '2021-11-04', 'Leeds'], ['Oliver Schmidt', 'DE', 'EUR', 'Individual', 'Active', 1432.6, 10, '2023-03-21', 'Munich'],
    ['Priya Raman', 'IE', 'EUR', 'Individual', 'Active', 1284.7, 9, '2024-03-18', 'Dublin'], ['Quinn Murphy', 'CA', 'CAD', 'Individual', 'Active', 845.9, 5, '2024-05-29', 'Toronto'],
    ['Rosa Alvarez', 'ES', 'EUR', 'Individual', 'Active', 478.3, 4, '2025-03-17', 'Valencia'], ['Sven Andersen', 'DK', 'DKK', 'Individual', 'Active', 5620, 7, '2024-08-14', 'Aarhus'],
    ['Tidewater Camping Co.', 'AU', 'AUD', 'Wholesale', 'Active', 31905.2, 41, '2022-02-08', 'Perth'], ['Ursula Keller', 'CH', 'CHF', 'Individual', 'Active', 1190.4, 6, '2024-04-11', 'Zürich'],
    ['Victor Almeida', 'PT', 'EUR', 'Business', 'Active', 2870.5, 12, '2023-10-25', 'Lisbon'],
  ];
  const streets = ['Marlay Park Road', 'Hafenstraße', 'Rue de la Paix', 'Via Rizzoli', 'Kungsgatan', 'Lombard Street', 'Calle Mayor', 'Prinsengracht', 'Oak Avenue', 'Mill Lane'];
  const customers = customerRows.map(([name, country, currency, segment, status, spend, orders, joined, city], n) => {
    const handle = name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
    return {
      id: id(1, n), name, email: segment === 'Business' || segment === 'Wholesale' ? `orders@${handle.split('.')[0]}.example` : `${handle}@example.com`,
      phone: n % 4 === 3 ? null : `+${country === 'IE' ? '353 87' : country === 'GB' ? '44 7700' : '49 151'} 555 ${String(100 + n * 37).slice(-4).padStart(4, '0')}`,
      country, defaultAddress: { line: `${3 + n * 7 % 90} ${streets[n % streets.length]}`, city, postalCode: `${10000 + n * 3719 % 89999}` },
      currency, segment, status, lifetimeSpend: spend, ordersCount: orders, loyaltyPoints: Math.round(spend / 2) % 4000, marketingOptIn: n % 3 !== 0, joinedOn: joined,
      closedOn: status === 'Closed' ? '2025-08-04' : null, notes: n % 5 === 0 ? 'Prefers delivery after 18:00.' : null,
    };
  });
  // The first customer a screen shows is the one the form examples use.
  const customersPage = { items: customers, page: 1, pageSize: 25, totalItems: 27, totalPages: 2 };

  // Products: name, sku, category, brand, origin, ships from, fulfilment, option names, price (EUR), variant option sets.
  const physical = (g, l, w, h, hs) => ({ type: 'Physical', weightGrams: g, lengthCm: l, widthCm: w, heightCm: h, hsCode: hs });
  const productRows = [
    ['Merino Crew Sweater', 'APP-MCS', 'Apparel', null, 'PT', ['Zona Industrial, Lote 12', 'Guimarães', '4810-100'], physical(640, 34, 26, 6, '611011'), 79, [['Heather Grey', 'S'], ['Heather Grey', 'M'], ['Navy', 'M'], ['Navy', 'L']], ['colour', 'size']],
    ['Waxed Canvas Backpack 22L', 'OUT-WCB', 'Outdoors', 'Fieldmark', 'PL', ['ul. Fabryczna 5', 'Łódź', '90-001'], physical(980, 48, 30, 18, '420292'), 129, [['Olive'], ['Black']], ['colour']],
    ['Oak Standing Desk', 'HOM-OSD', 'Home', null, 'DE', ['Werkstraße 14', 'Kassel', '34117'], physical(32000, 160, 80, 12, '940330'), 549, [['Oak', '140 cm'], ['Oak', '160 cm'], ['Walnut', '160 cm']], ['finish', 'width']],
    ['Noise-Cancelling Headphones H3', 'ELE-NCH', 'Electronics', 'Sonvik', 'CN', ['Distribution Park, Unit 7', 'Rotterdam', '3011 AA'], physical(420, 22, 20, 9, '851830'), 229, [['Black'], ['Silver']], ['colour']],
    ['Ceramic Pour-Over Set', 'HOM-CPO', 'Home', null, 'PT', ['Rua da Cerâmica 3', 'Aveiro', '3800-200'], physical(1100, 28, 28, 20, '691200'), 48.9, [['Matte White'], ['Slate']], ['colour']],
    ['Trail Running Shoes Ridge 2', 'APP-TRR', 'Apparel', 'Ridge', 'VN', ['Distribution Park, Unit 7', 'Rotterdam', '3011 AA'], physical(560, 32, 20, 12, '640411'), 119.9, [['Charcoal', '41'], ['Charcoal', '43'], ['Charcoal', '45']], ['colour', 'size']],
    ['Smart LED Desk Lamp', 'ELE-SDL', 'Electronics', 'Lumio', 'CN', ['Distribution Park, Unit 7', 'Rotterdam', '3011 AA'], physical(750, 45, 18, 12, '940520'), 59.9, [['White'], ['Black']], ['colour']],
    ['Insulated Steel Bottle 750 ml', 'OUT-ISB', 'Outdoors', null, 'DE', ['Werkstraße 14', 'Kassel', '34117'], physical(380, 28, 8, 8, '961700'), 27.5, [['Forest'], ['Sand'], ['Slate']], ['colour']],
    ['Linen Duvet Cover Set', 'HOM-LDC', 'Home', null, 'LT', ['Pramonės g. 21', 'Kaunas', '47188'], physical(1400, 40, 30, 12, '630231'), 149, [['Oatmeal', 'Double'], ['Oatmeal', 'King']], ['colour', 'size']],
    ['USB-C Dock 9-in-1', 'ELE-UCD', 'Electronics', 'Sonvik', 'CN', ['Distribution Park, Unit 7', 'Rotterdam', '3011 AA'], physical(310, 16, 8, 3, '847330'), 89, [['Space Grey']], ['colour']],
    ['Cotton Poplin Shirt', 'APP-CPS', 'Apparel', null, 'PT', ['Zona Industrial, Lote 12', 'Guimarães', '4810-100'], physical(280, 30, 24, 4, '620520'), 64, [['White', 'M'], ['White', 'L'], ['Sky', 'M']], ['colour', 'size']],
    ['2-Person Lightweight Tent', 'OUT-LWT', 'Outdoors', 'Fieldmark', 'PL', ['ul. Fabryczna 5', 'Łódź', '90-001'], physical(2300, 52, 16, 16, '630622'), 379, [['Moss']], ['colour']],
    ['Digital Gift Card', 'GIF-DGC', 'Home', null, 'IE', ['Docklands House', 'Dublin', 'D01 F5P2'], { type: 'Digital', delivery: 'Email', downloadLimit: null, licenseRequired: false }, 50, [['€25'], ['€50'], ['€100']], ['value']],
    ['Monthly Coffee Subscription', 'GIF-MCS', 'Home', 'Harbour Roast', 'IE', ['Docklands House', 'Dublin', 'D01 F5P2'], { type: 'Subscription', intervalDays: 30, weightGrams: 500, skipAllowed: true }, 18.5, [['Whole bean'], ['Ground']], ['grind']],
  ];
  const variants = [];
  const products = productRows.map(([name, sku, category, brand, originCountry, [line, city, postalCode], fulfilment, price, optionSets, optionNames], n) => {
    const productId = id(2, n);
    const own = optionSets.map((values, k) => {
      const options = Object.fromEntries(optionNames.map((key, j) => [key, values[j]]));
      const code = values.map(v => v.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase()).join('-');
      const base = sku === 'GIF-DGC' ? [25, 50, 100][k] : price + (k % 2) * (price > 200 ? 20 : 0);
      return {
        id: id(3, n * 10 + k), productId, productName: name, sku: `${sku}-${code}`, name: values.join(' / '), options, price: base,
        compareAtPrice: n % 4 === 0 && k === 0 ? Math.round(base * 1.25) : null, currency: 'EUR', active: !(n === 5 && k === 2),
      };
    });
    variants.push(...own);
    return {
      id: productId, name, sku, category, brand, status: n === 11 ? 'Archived' : 'Active', originCountry, shipsFrom: { line, city, postalCode },
      supplierEmail: `restock@${(brand || sku.split('-')[1]).toLowerCase().replace(/[^a-z]+/g, '')}-supply.example`, fulfilment, variants: own,
      averageRating: n % 5 === 4 ? null : Math.round((3.8 + (n * 37 % 12) / 10) * 10) / 10, createdAt: iso(TODAY - (700 - n * 31) * DAY),
    };
  });
  const productsPage = { items: products.slice(0, 5), page: 1, pageSize: 5, totalItems: 51, totalPages: 11 };

  // Orders: 188 in total, the newest 100 below.
  const rates = { EUR: 1, USD: 1.09, GBP: 0.86, CHF: 0.96, SEK: 11.4, JPY: 163, NOK: 11.7, DKK: 7.46, CAD: 1.5, AUD: 1.66, PLN: 4.3 };
  const statusWeights = [['Pending', 14], ['Paid', 12], ['Processing', 17], ['Packed', 9], ['Shipped', 19], ['Delivered', 15], ['Cancelled', 6], ['Refunded', 4], ['PaymentFailed', 4]];
  const weighted = list => { let r = rand() * list.reduce((a, [, w]) => a + w, 0); for (const [v, w] of list) if ((r -= w) < 0) return v; return list[0][0]; };
  const staffActors = [{ email: 'sam.support@acme.dev', name: 'Sam Support' }, { email: 'ada.admin@acme.dev', name: 'Ada Admin' }, { email: 'cara.customer@acme.dev', name: 'Cara Customer' }];
  const references = ['Q4 desk setup', 'Office refresh', 'Staff uniforms', 'Gift for Mum', 'Camping trip', 'Café reopening', 'Autumn restock', 'Birthday order'];
  const noteLines = [['Leave with the concierge, flat 4B'], ['Ring twice, back door'], ['Deliver after 18:00', 'Call on arrival'], ['Fragile: ceramic'], ['Gift: no price on the slip']];
  const activeVariants = variants.filter(v => v.active);
  const orderCustomers = customers.filter(c => c.status !== 'Closed');
  const orders = [];
  for (let n = 0; n < 100; n++) {
    const customer = pick(orderCustomers);
    const status = weighted(statusWeights);
    const created = TODAY - Math.round((n * 0.62 + rand() * 0.5) * DAY) - Math.round(rand() * 6) * 3600000;
    const lineCount = 1 + Math.floor(rand() * 3);
    const lines = Array.from({ length: lineCount }, (_, k) => {
      const v = pick(activeVariants);
      const quantity = 1 + Math.floor(rand() * (v.price < 60 ? 4 : 2));
      const unitPrice = Math.round(v.price * rates[customer.currency] * (customer.currency === 'JPY' ? 1 : 100)) / (customer.currency === 'JPY' ? 1 : 100);
      const total = Math.round(unitPrice * quantity * 100) / 100;
      return { id: id(5, n * 4 + k), variant: { id: v.id, name: `${v.productName}, ${v.name}`, sku: v.sku, currency: customer.currency }, quantity, unitPrice, discount: 0, total, shipped: ['Shipped', 'Delivered'].includes(status) ? quantity : 0 };
    });
    const coupon = rand() < 0.22 ? pick(['SPRING25', 'WELCOME10', 'FREESHIP']) : null;
    if (coupon) for (const line of lines) { line.discount = Math.round(line.total * 0.1 * 100) / 100; line.total = Math.round((line.total - line.discount) * 100) / 100; }
    const amount = Math.round(lines.reduce((sum, line) => sum + line.total, 0) * 100) / 100;
    const number = `ORD-2026-${String(188 - n).padStart(6, '0')}`;
    const settled = !['Pending', 'PaymentFailed'].includes(status);
    orders.push({
      id: id(4, n), number, status, customer: { id: customer.id, name: customer.name, email: customer.email }, shippingAddress: { ...customer.defaultAddress },
      lines, amount, currency: customer.currency, deliverBy: day(created + (2 + Math.floor(rand() * 9)) * DAY), shippingMethod: pick(['Standard', 'Standard', 'Express', 'Same day']),
      reference: rand() < 0.55 ? `PO-2026-${1000 + Math.floor(rand() * 8000)} / ${pick(references)}` : null, couponCode: coupon,
      deliveryNotes: rand() < 0.4 ? { lines: pick(noteLines), packingSlipId: `PS-2026-${String(188 - n).padStart(6, '0')}` } : null, channel: pick(['Web', 'Web', 'App', 'Phone']),
      externalId: rand() < 0.5 ? `ERP-${String(Math.floor(rand() * 9000000) + 1000000)}` : null, createdBy: n % 7 === 0 ? staffActors[0] : n % 11 === 0 ? staffActors[1] : staffActors[2],
      createdAt: iso(created), updatedAt: iso(created + (settled ? 6 : 0.4) * 3600000), placedAt: iso(created + 240000),
      cancelReason: status === 'Cancelled' ? pick(['Customer changed their mind.', 'Duplicate order.', 'Item out of stock.']) : null,
    });
  }
  const ordersLarge = { items: orders, page: 1, pageSize: 100, totalItems: 188, totalPages: 2 };
  const ordersPage = { items: orders.slice(0, 5), page: 1, pageSize: 5, totalItems: 188, totalPages: 38 };
  // The detail sample: a paid order mid-fulfilment, with every nested object filled.
  const order = {
    ...JSON.parse(JSON.stringify(schemas.Order.examples[0])),
  };

  // The mismatching customer for the response-schema screens: a 3-letter country, a missing
  // required property (email) and one the spec doesn't document (legacyCode).
  const customer = { ...customers[18] };
  const { email, ...withoutEmail } = customer;
  const customerMismatch = { ...withoutEmail, country: 'IRL', legacyCode: 'DUB-CUS-0018' };

  window.TB_SAMPLES = { ordersPage, ordersLarge, order, customersPage, customer, customerMismatch, productsPage };
})();
