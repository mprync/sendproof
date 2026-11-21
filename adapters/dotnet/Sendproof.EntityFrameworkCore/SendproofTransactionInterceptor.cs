using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// Refuses a commit of the Preview transaction. A handler that calls <c>Database.CommitTransaction()</c> (or commits a
/// transaction object it got from <c>CurrentTransaction</c>) would persist the Preview's writes, so the commit never
/// reaches the database and the Preview can never be confirmed, even if the handler catches the exception.
/// </summary>
internal sealed class SendproofTransactionInterceptor(CaptureContext capture) : DbTransactionInterceptor
{
    public override InterceptionResult TransactionCommitting(DbTransaction transaction, TransactionEventData eventData,
        InterceptionResult result) => Guard(result);

    public override ValueTask<InterceptionResult> TransactionCommittingAsync(DbTransaction transaction, TransactionEventData eventData,
        InterceptionResult result, CancellationToken cancellationToken = default) => ValueTask.FromResult(Guard(result));

    private InterceptionResult Guard(InterceptionResult result) => capture.Current is { InPreview: true }
        ? throw capture.RefuseInPreview("Preview owns the SQL transaction, so the handler's commit cannot run during Preview.")!
        : result;
}
