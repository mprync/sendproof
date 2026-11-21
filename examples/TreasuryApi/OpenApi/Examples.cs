using System.Text.Json.Nodes;

namespace TreasuryApi;

/// <summary>Example bodies shown in the OpenAPI document. Dates are relative to today, so examples never go stale.</summary>
internal static class Examples
{
    private static string Date(int days) => DateOnly.FromDateTime(DateTime.UtcNow.AddDays(days)).ToString("yyyy-MM-dd");
    private static string Instant(int days, int hour) =>
        new DateTimeOffset(DateTime.UtcNow.Date.AddDays(days).AddHours(hour), TimeSpan.Zero).ToString("yyyy-MM-ddTHH:mm:ssZ");

    private static JsonObject Account() => new()
    {
        ["id"] = DemoData.OperatingEurId, ["name"] = "Operating EUR", ["iban"] = "IE29 AIBK 9311 5212 3456 78", ["currency"] = "EUR"
    };

    private static JsonObject Northwind() => new()
    {
        ["id"] = DemoData.NorthwindId, ["name"] = "Northwind Logistics GmbH", ["country"] = "DE"
    };

    private static JsonObject Money(decimal value, string currency) => new() { ["value"] = value, ["currency"] = currency };

    /// <summary>The example of a schema, if it has one.</summary>
    internal static JsonNode? For(Type type) => type.Name switch
    {
        nameof(LoginRequest) => new JsonObject { ["email"] = "ada.admin@acme.dev", ["password"] = DemoData.Password },
        nameof(Persona) => new JsonObject { ["email"] = "ada.admin@acme.dev", ["name"] = "Ada Admin", ["role"] = "admin" },
        nameof(CreatePaymentRequest) => new JsonObject
        {
            ["debitAccountId"] = DemoData.OperatingEurId,
            ["counterpartyId"] = DemoData.NorthwindId,
            ["amount"] = 50000,
            ["currency"] = "EUR",
            ["valueDate"] = Date(3),
            ["priority"] = "Normal",
            ["reference"] = "INV-2026-1184 / Q4 freight",
            ["remittanceLines"] = new JsonArray("Freight Oct–Nov, PO 88213")
        },
        nameof(UpdatePaymentRequest) => new JsonObject
        {
            ["counterpartyId"] = DemoData.NorthwindId, ["amount"] = 48250.5, ["valueDate"] = Date(4), ["priority"] = "Urgent",
            ["reference"] = "INV-2026-1184 / corrected", ["remittanceLines"] = new JsonArray("Freight Oct–Nov, PO 88213 (corrected)")
        },
        nameof(Payment) => new JsonObject
        {
            ["id"] = "7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13", ["number"] = "PAY-2026-000187", ["status"] = "PendingApproval",
            ["debitAccount"] = Account(), ["counterparty"] = Northwind(), ["amount"] = 50000, ["currency"] = "EUR",
            ["valueDate"] = Date(3), ["priority"] = "Normal", ["reference"] = "INV-2026-1184 / Q4 freight",
            ["remittanceInformation"] = new JsonObject { ["lines"] = new JsonArray("Freight Oct–Nov, PO 88213"), ["endToEndId"] = "PAY-2026-000187" },
            ["chargeBearer"] = null, ["purposeCode"] = "SUPP", ["externalId"] = "ERP-4400123",
            ["approvals"] = new JsonArray(new JsonObject
            {
                ["id"] = "0b8d3f0e-2d4a-4c7e-9a41-5f6a7b8c9d01", ["decision"] = "Rejected",
                ["actor"] = new JsonObject { ["email"] = "devi.approver@acme.dev", ["name"] = "Devi Approver" },
                ["comment"] = "Missing purchase order reference.", ["decidedAt"] = Instant(-1, 10)
            }),
            ["createdBy"] = new JsonObject { ["email"] = "tomas.treasurer@acme.dev", ["name"] = "Tomás Treasurer" },
            ["createdAt"] = Instant(-2, 9), ["updatedAt"] = Instant(0, 8), ["submittedAt"] = Instant(0, 8)
        },
        nameof(RejectPaymentRequest) => new JsonObject { ["reason"] = "Amount does not match the invoice." },
        nameof(ApprovePaymentRequest) => new JsonObject { ["comment"] = "Matches the invoice and PO." },
        nameof(CancelPaymentRequest) => new JsonObject { ["reason"] = "Invoice disputed with the supplier." },
        nameof(ApprovalRequest) => new JsonObject
        {
            ["paymentId"] = "7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13", ["number"] = "PAY-2026-000187", ["amount"] = Money(50000, "EUR"),
            ["valueDate"] = Date(3), ["debitAccount"] = Account(), ["counterparty"] = Northwind(),
            ["requestedBy"] = new JsonObject { ["email"] = "tomas.treasurer@acme.dev", ["name"] = "Tomás Treasurer" },
            ["submittedAt"] = Instant(0, 8), ["canApprove"] = true
        },
        nameof(Account) => new JsonObject
        {
            ["id"] = DemoData.OperatingEurId, ["name"] = "Operating EUR", ["entity"] = "Acme Holdings Ltd", ["entityCountry"] = "IE",
            ["bankName"] = "AIB", ["bic"] = "AIBKIE2D", ["iban"] = "IE29 AIBK 9311 5212 3456 78", ["currency"] = "EUR",
            ["type"] = "Operating", ["status"] = "Open", ["availableBalance"] = 250000, ["ledgerBalance"] = 250000,
            ["openedOn"] = "2019-03-18", ["description"] = "Main euro operating account for the group."
        },
        nameof(CreateAccountRequest) => new JsonObject
        {
            ["name"] = "Milan Operating EUR", ["entity"] = "Acme Italia Srl", ["entityCountry"] = "IT", ["bankName"] = "UniCredit",
            ["bic"] = "UNCRITMM", ["iban"] = "IT60 X054 2811 1010 0000 0123 456", ["currency"] = "EUR", ["type"] = "Operating",
            ["description"] = "Operating account for the Italian branch."
        },
        nameof(UpdateAccountRequest) => new JsonObject { ["name"] = "Operating EUR", ["description"] = "Main euro operating account.", ["status"] = "Open" },
        nameof(AccountBalance) => new JsonObject
        {
            ["account"] = Account(), ["ledgerBalance"] = 250000, ["availableBalance"] = 250000, ["reservedAmount"] = 0, ["asOf"] = Instant(0, 9)
        },
        nameof(BalancePoint) => new JsonObject { ["asOf"] = Instant(0, 9), ["ledgerBalance"] = 251240.5, ["availableBalance"] = 251240.5 },
        nameof(Counterparty) => new JsonObject
        {
            ["id"] = DemoData.NorthwindId, ["name"] = "Northwind Logistics GmbH", ["type"] = "Supplier", ["status"] = "Active", ["country"] = "DE",
            ["address"] = new JsonObject { ["line"] = "12 Hafenstraße", ["city"] = "Hamburg", ["postalCode"] = "20457" },
            ["contactEmail"] = "payables@northwind-logistics.example",
            ["bankDetails"] = new JsonObject { ["scheme"] = "Iban", ["iban"] = "DE89 3704 0044 0532 0130 00", ["bic"] = "COBADEFF" },
            ["accountIdentifier"] = "DE89 3704 0044 0532 0130 00", ["createdAt"] = Instant(-400, 9)
        },
        nameof(CreateCounterpartyRequest) => new JsonObject
        {
            ["name"] = "Lakeside Facilities Inc", ["type"] = "Supplier", ["country"] = "US",
            ["address"] = new JsonObject { ["line"] = "480 Lake Shore Drive", ["city"] = "Chicago", ["postalCode"] = "60611" },
            ["contactEmail"] = "ap@lakeside-facilities.example",
            ["bankDetails"] = new JsonObject
            {
                ["scheme"] = "UsAch", ["routingNumber"] = "021000021", ["accountNumber"] = "4827163950", ["bankName"] = "JPMorgan Chase"
            }
        },
        nameof(UpdateCounterpartyRequest) => new JsonObject
        {
            ["name"] = "Northwind Logistics GmbH",
            ["address"] = new JsonObject { ["line"] = "12 Hafenstraße", ["city"] = "Hamburg", ["postalCode"] = "20457" },
            ["contactEmail"] = "payables@northwind-logistics.example",
            ["bankDetails"] = new JsonObject { ["scheme"] = "Iban", ["iban"] = "DE89 3704 0044 0532 0130 00", ["bic"] = "COBADEFF" }
        },
        nameof(FxQuoteRequest) => new JsonObject { ["pair"] = "EURUSD", ["side"] = "Buy", ["type"] = "Forward", ["baseAmount"] = 500000, ["valueDate"] = Date(60) },
        nameof(FxQuote) => new JsonObject
        {
            ["pair"] = "EURUSD", ["side"] = "Buy", ["type"] = "Forward", ["rate"] = 1.09254, ["forwardPoints"] = 0.00522,
            ["baseAmount"] = Money(500000, "EUR"), ["quoteAmount"] = Money(546270, "USD"), ["valueDate"] = Date(60),
            ["validUntil"] = Instant(0, 12)
        },
        nameof(BookFxDealRequest) => new JsonObject
        {
            ["pair"] = "EURUSD", ["side"] = "Buy", ["type"] = "Spot", ["baseAmount"] = 250000, ["rate"] = 1.08742
        },
        nameof(CancelFxDealRequest) => new JsonObject { ["reason"] = "Exposure no longer required." },
        nameof(BankStatementSummary) => StatementExample(false),
        nameof(BankStatement) => StatementExample(true),
        nameof(StatementEntry) => EntryExample(),
        nameof(User) => new JsonObject
        {
            ["id"] = 2, ["email"] = "ben.approver@acme.dev", ["name"] = "Ben Approver", ["role"] = "payments.approve",
            ["jobTitle"] = "Treasury Manager", ["isActive"] = true
        },
        nameof(Role) => new JsonObject
        {
            ["name"] = "payments.approve", ["description"] = "Works payments: creates them and reviews other people's.",
            ["permissions"] = new JsonArray("Create, revise, submit and cancel payments", "Approve or reject payments created by someone else"),
            ["userCount"] = 3
        },
        nameof(ChangeRoleRequest) => new JsonObject { ["role"] = "payments.approve" },
        nameof(LegacyAccountBalance) => new JsonObject { ["accountId"] = DemoData.OperatingEurId, ["balance"] = 250000, ["currency"] = "EUR" },
        nameof(MoneyAmount) => Money(1250.75m, "EUR"),
        nameof(Address) => new JsonObject { ["line"] = "12 Hafenstraße", ["city"] = "Hamburg", ["postalCode"] = "20457" },
        nameof(IbanBankDetails) => new JsonObject { ["scheme"] = "Iban", ["iban"] = "DE89 3704 0044 0532 0130 00", ["bic"] = "COBADEFF" },
        nameof(UsAchBankDetails) => new JsonObject { ["scheme"] = "UsAch", ["routingNumber"] = "021000021", ["accountNumber"] = "4827163950", ["bankName"] = "JPMorgan Chase" },
        nameof(SwiftBankDetails) => new JsonObject { ["scheme"] = "Swift", ["bic"] = "DBSSSGSG", ["accountNumber"] = "0123456789", ["bankName"] = "DBS Bank" },
        nameof(SpotFxDeal) => FxDealExample(forward: false),
        nameof(ForwardFxDeal) => FxDealExample(forward: true),
        _ => null
    };

    private static JsonObject EntryExample() => new()
    {
        ["id"] = "4c1a9e52-7b3d-4f08-8e6a-2d5b9c0f1a73", ["sequence"] = 3, ["type"] = "Debit", ["amount"] = Money(50000, "EUR"),
        ["bookingDate"] = Date(-1), ["valueDate"] = Date(-1), ["entryReference"] = "BK4827163950", ["endToEndId"] = "PAY-2026-000142",
        ["counterpartyName"] = "Northwind Logistics GmbH", ["remittance"] = "INV-2026-1184 / Q4 freight",
        ["bankTransactionCode"] = "PMNT-ICDT-ESCT", ["matchedPaymentId"] = "7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13"
    };

    private static JsonObject StatementExample(bool withEntries)
    {
        var statement = new JsonObject
        {
            ["id"] = "a1b2c3d4-0000-4000-8000-00000000c053", ["number"] = "AIBK-20261119-417", ["account"] = Account(),
            ["statementDate"] = Date(-1), ["openingBalance"] = Money(300000, "EUR"), ["closingBalance"] = Money(250000, "EUR"),
            ["entryCount"] = 1, ["receivedAt"] = Instant(0, 5)
        };
        if (withEntries) statement["entries"] = new JsonArray(EntryExample());
        return statement;
    }

    private static JsonObject FxDealExample(bool forward)
    {
        var deal = new JsonObject
        {
            ["type"] = forward ? "Forward" : "Spot", ["id"] = "e5f6a7b8-1111-4222-8333-444455556666", ["number"] = "FX-2026-0042",
            ["pair"] = "EURUSD", ["side"] = "Buy", ["baseAmount"] = Money(500000, "EUR"), ["quoteAmount"] = Money(546270, "USD"),
            ["rate"] = 1.09254, ["status"] = "Booked", ["tradeDate"] = Date(-1), ["bank"] = "J.P. Morgan",
            ["bookedBy"] = new JsonObject { ["email"] = "ben.approver@acme.dev", ["name"] = "Ben Approver" }, ["bookedAt"] = Instant(-1, 11)
        };
        if (forward) { deal["valueDate"] = Date(60); deal["forwardPoints"] = 0.00522; deal["daysToMaturity"] = 61; }
        else deal["settlementDate"] = Date(1);
        return deal;
    }
}
