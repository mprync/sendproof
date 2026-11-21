using System.Collections.Concurrent;
using Sendproof.AspNetCore;

namespace TreasuryApi;

/// <summary>
/// A local, in-memory stand-in for notification delivery; no email is sent and nothing leaves the process.
/// </summary>
/// <remarks>
/// Every method records an effect with <see cref="SendproofPreview"/>. During a Preview the effect is captured and
/// suppressed; during a Send it is delivered, which here means it is appended to <see cref="Messages"/>.
/// </remarks>
public sealed class DemoNotificationQueue
{
    private const string Sender = "treasury@acme.dev";
    private const string OperationsMailbox = "treasury-ops@acme.dev";
    private readonly ConcurrentQueue<string> _messages = new();

    /// <summary>Gets the messages queued by committed requests in this process.</summary>
    public IReadOnlyCollection<string> Messages => _messages.ToArray();

    /// <summary>Tells the operations mailbox that a draft payment was created and funds were reserved.</summary>
    internal void PaymentCreated(Guid paymentId, SendproofPreview preview)
    {
        Email(preview, $"Payment {paymentId} created for {OperationsMailbox}", [OperationsMailbox],
            $"Payment {paymentId} created", "A draft payment was created and funds were reserved.");
        preview.TryRecordLog("Information", "Payment created and funds reserved.");
    }

    /// <summary>Asks the approvers to review a payment that was submitted.</summary>
    internal void PaymentSubmitted(PaymentRecord payment, IEnumerable<string> approvers, SendproofPreview preview)
    {
        var to = approvers.ToArray();
        Email(preview, $"Approval requested for {payment.Number}", to,
            $"Approval needed: {payment.Number}",
            $"{payment.Number} for {payment.Amount:N2} {payment.Currency} is waiting for approval.");
        preview.TryRecordLog("Information", $"Payment {payment.Number} submitted for approval to {to.Length} approver(s).");
    }

    /// <summary>Tells a payment's creator that it was approved or rejected.</summary>
    internal void PaymentReviewed(PaymentRecord payment, PaymentApprovalRecord approval, SendproofPreview preview)
    {
        var verdict = approval.Decision.ToString().ToLowerInvariant();
        Email(preview, $"Payment {payment.Number} {verdict}", [payment.CreatedBy],
            $"{payment.Number} {verdict}",
            approval.Comment is null ? $"{approval.ActorName} {verdict} the payment." : $"{approval.ActorName} {verdict} the payment: {approval.Comment}");
        if (approval.Decision == ApprovalDecision.Approved)
            Job(preview, $"Release {payment.Number} to the bank", "payments.release", new { paymentId = payment.Id, valueDate = payment.ValueDate });
        preview.TryRecordLog("Information", $"Payment {payment.Number} {verdict} by {approval.ActorEmail}.");
    }

    /// <summary>Tells the operations mailbox that a payment was cancelled and its funds released.</summary>
    internal void PaymentCancelled(PaymentRecord payment, SendproofPreview preview)
    {
        Email(preview, $"Payment {payment.Number} cancelled", [OperationsMailbox], $"{payment.Number} cancelled",
            $"Funds of {payment.Amount:N2} {payment.Currency} were released back to the debit account.");
        preview.TryRecordLog("Information", $"Payment {payment.Number} cancelled; reservation released.");
    }

    /// <summary>Queues sanctions screening for a new counterparty and tells operations.</summary>
    internal void CounterpartyCreated(CounterpartyRecord counterparty, SendproofPreview preview)
    {
        Job(preview, $"Screen {counterparty.Name} against sanctions lists", "counterparties.screen", new { counterpartyId = counterparty.Id });
        Email(preview, $"Counterparty {counterparty.Name} added", [OperationsMailbox], $"New counterparty: {counterparty.Name}",
            $"{counterparty.Name} ({counterparty.Country}) was added and is awaiting screening.");
        preview.TryRecordLog("Information", $"Counterparty {counterparty.Name} added.");
    }

    /// <summary>Publishes a booked FX deal to the treasury management system and tells operations.</summary>
    internal void FxDealBooked(FxDealRecord deal, SendproofPreview preview)
    {
        Message(preview, $"Publish FX deal {deal.Number}", "treasury.fx.booked",
            new { deal.Id, deal.Number, deal.Pair, deal.Side, deal.BaseAmount, deal.Rate, deal.ValueDate });
        Email(preview, $"FX deal {deal.Number} booked", [OperationsMailbox], $"FX deal {deal.Number} booked",
            $"{deal.Side} {deal.BaseAmount:N2} {deal.Pair.ToString()[..3]} at {deal.Rate} for value {deal.ValueDate:yyyy-MM-dd}.");
        preview.TryRecordLog("Information", $"FX deal {deal.Number} booked with {deal.Bank}.");
    }

    /// <summary>Tells the operations mailbox that an FX deal was cancelled.</summary>
    internal void FxDealCancelled(FxDealRecord deal, SendproofPreview preview)
    {
        Email(preview, $"FX deal {deal.Number} cancelled", [OperationsMailbox], $"FX deal {deal.Number} cancelled",
            $"The deal with {deal.Bank} was cancelled: {deal.CancelReason ?? "no reason given"}.");
        preview.TryRecordLog("Warning", $"FX deal {deal.Number} cancelled.");
    }

    /// <summary>Tells a user their role changed and publishes the change for access reviews.</summary>
    internal void RoleChanged(DemoUser user, string previousRole, SendproofPreview preview)
    {
        Email(preview, $"Role of {user.Email} changed", [user.Email], "Your treasury role changed",
            $"Your role changed from {previousRole} to {user.Role}. Sign in again to use it.");
        Message(preview, $"Publish role change for {user.Email}", "treasury.access.role-changed",
            new { user.Email, previousRole, user.Role });
        preview.TryRecordLog("Warning", $"Role of {user.Email} changed from {previousRole} to {user.Role}.");
    }

    /// <summary>Tells operations that an account was closed.</summary>
    internal void AccountClosed(AccountRecord account, SendproofPreview preview)
    {
        Email(preview, $"Account {account.Name} closed", [OperationsMailbox], $"Account closed: {account.Name}",
            $"{account.Iban} at {account.BankName} was closed.");
        preview.TryRecordLog("Warning", $"Account {account.Name} closed.");
    }

    private void Email(SendproofPreview preview, string description, string[] to, string subject, string text)
    {
        if (!preview.TryRecordEmail(description, Sender, to, [], subject, text)) _messages.Enqueue(description);
    }

    private void Job(SendproofPreview preview, string description, string name, object arguments)
    {
        if (!preview.TryRecordJob(description, name, arguments, "treasury")) _messages.Enqueue(description);
    }

    private void Message(SendproofPreview preview, string description, string topic, object payload)
    {
        if (!preview.TryRecordMessage(description, topic, payload)) _messages.Enqueue(description);
    }
}
