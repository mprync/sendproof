using System.ComponentModel;
using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// The connection EF Core uses, wrapped so every command sent on it meets the Preview's transaction-control guard,
/// whichever API sends it: EF Core itself, <c>Database.GetDbConnection()</c> with Dapper, or a hand-written
/// <see cref="DbCommand"/> (spec/data-stores.md "Transaction-control statements from the handler").
/// </summary>
/// <remarks>
/// <para>During a Preview it refuses, before anything is sent: a command <see cref="SqlStatements"/> says would end or
/// escape the Preview transaction; a commit of the Preview transaction, or a rollback other than the Preview's own;
/// beginning a second transaction (on MySQL a <c>BEGIN</c> commits the first); closing the connection while the
/// Preview transaction is open (the server would roll it back and later commands would commit on their own); and the
/// backstop savepoint's name in the savepoint methods. Each refusal fails the Preview with 500, even if the handler
/// catches it. Outside a Preview everything passes straight through.</para>
/// <para><see cref="SendproofConnectionInterceptor"/> installs it for providers whose EF Core integration accepts a
/// wrapped connection (SQLite), when EF Core creates the connection. A <see cref="DbConnection"/> the application creates
/// and hands to EF Core is not wrapped.
/// <see cref="DbConnection.CreateBatch"/> is not supported on the wrapped connection, so a batch can't bypass the
/// guard.</para>
/// </remarks>
internal sealed class SendproofDbConnection : DbConnection
{
    private readonly CaptureContext _capture;
    private readonly Func<IReadOnlySet<string>?> _safeProcedures;
    private SendproofDbTransaction? _transaction;

    internal SendproofDbConnection(DbConnection inner, CaptureContext capture, bool mysql, Func<IReadOnlySet<string>?> safeProcedures)
    {
        Inner = inner;
        _capture = capture;
        MySql = mysql;
        _safeProcedures = safeProcedures;
        inner.StateChange += (_, change) => OnStateChange(change);
    }

    /// <summary>The provider's connection. Only Sendproof itself uses it directly (the savepoint backstop).</summary>
    internal DbConnection Inner { get; }

    /// <summary>Whether the database is MySQL or MariaDB, which also commit implicitly and run procedures.</summary>
    internal bool MySql { get; }

    /// <summary>The provider's transaction behind a wrapped one, for commands sent on <see cref="Inner"/>.</summary>
    internal static DbTransaction? Unwrap(DbTransaction? transaction) =>
        transaction is SendproofDbTransaction wrapped ? wrapped.Inner : transaction;

    /// <summary>The Preview's open transaction on this connection, if any.</summary>
    private bool TransactionOpen => _transaction is { Completed: false };

    /// <summary>Throws (and fails the Preview) when a Preview is running; otherwise does nothing.</summary>
    internal void Refuse(string what)
    {
        if (_capture.RefuseInPreview($"Preview owns the SQL transaction, so {what} cannot run during Preview.") is { } refusal)
        {
            throw refusal;
        }
    }

    /// <summary>Refuses a command that would end or escape the Preview transaction.</summary>
    internal void Guard(DbCommand command) =>
        SqlGuard.Check(_capture, command.CommandType, command.CommandText, MySql, _safeProcedures());

    /// <summary>Records a failed command, so a transaction the database rolled back refuses every later statement.</summary>
    internal void Failed(Exception error) => SqlGuard.Failed(_capture, error);

    /// <summary>Refuses a savepoint method naming the backstop savepoint.</summary>
    internal void GuardSavepoint(string name)
    {
        if (string.Equals(name.Trim('`', '"', '[', ']'), SqlStatements.PreviewSavepointName, StringComparison.OrdinalIgnoreCase))
        {
            Refuse("using the Preview's savepoint");
        }
    }

    [AllowNull]
    public override string ConnectionString
    {
        get => Inner.ConnectionString;
        set => Inner.ConnectionString = value;
    }

    public override int ConnectionTimeout => Inner.ConnectionTimeout;
    public override string Database => Inner.Database;
    public override string DataSource => Inner.DataSource;
    public override string ServerVersion => Inner.ServerVersion;
    public override ConnectionState State => Inner.State;
    public override bool CanCreateBatch => false;
    protected override DbProviderFactory? DbProviderFactory => DbProviderFactories.GetFactory(Inner);

    [EditorBrowsable(EditorBrowsableState.Never)]
    public override ISite? Site
    {
        get => Inner.Site;
        set => Inner.Site = value;
    }

    public override void ChangeDatabase(string databaseName) => Inner.ChangeDatabase(databaseName);

    public override Task ChangeDatabaseAsync(string databaseName, CancellationToken cancellationToken = default) =>
        Inner.ChangeDatabaseAsync(databaseName, cancellationToken);

    public override void Open() => Inner.Open();

    public override Task OpenAsync(CancellationToken cancellationToken) => Inner.OpenAsync(cancellationToken);

    public override void Close()
    {
        if (TransactionOpen) Refuse("closing its connection");
        Inner.Close();
    }

    public override Task CloseAsync()
    {
        if (TransactionOpen) Refuse("closing its connection");
        return Inner.CloseAsync();
    }

    public override void EnlistTransaction(System.Transactions.Transaction? transaction) => Inner.EnlistTransaction(transaction);

    public override DataTable GetSchema() => Inner.GetSchema();

    public override DataTable GetSchema(string collectionName) => Inner.GetSchema(collectionName);

    public override DataTable GetSchema(string collectionName, string?[] restrictionValues) =>
        Inner.GetSchema(collectionName, restrictionValues);

    protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel)
    {
        // The first transaction is the Preview's own (EF Core begins it for the provider); a second would replace it.
        if (TransactionOpen) Refuse("beginning another transaction");
        return _transaction = new SendproofDbTransaction(this, Inner.BeginTransaction(isolationLevel));
    }

    protected override async ValueTask<DbTransaction> BeginDbTransactionAsync(IsolationLevel isolationLevel,
        CancellationToken cancellationToken)
    {
        if (TransactionOpen) Refuse("beginning another transaction");
        return _transaction = new SendproofDbTransaction(this, await Inner.BeginTransactionAsync(isolationLevel, cancellationToken));
    }

    protected override DbCommand CreateDbCommand() => new SendproofDbCommand(this, Inner.CreateCommand());

    protected override void Dispose(bool disposing)
    {
        if (disposing) Inner.Dispose();
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await Inner.DisposeAsync();
        await base.DisposeAsync();
    }
}

/// <summary>A command on a <see cref="SendproofDbConnection"/>: guarded before it runs, otherwise the provider's own.</summary>
internal sealed class SendproofDbCommand(SendproofDbConnection connection, DbCommand inner) : DbCommand
{
    private SendproofDbConnection? _connection = connection;
    private DbTransaction? _transaction;

    [AllowNull]
    public override string CommandText
    {
        get => inner.CommandText;
        set => inner.CommandText = value;
    }

    public override int CommandTimeout
    {
        get => inner.CommandTimeout;
        set => inner.CommandTimeout = value;
    }

    public override CommandType CommandType
    {
        get => inner.CommandType;
        set => inner.CommandType = value;
    }

    public override bool DesignTimeVisible
    {
        get => inner.DesignTimeVisible;
        set => inner.DesignTimeVisible = value;
    }

    public override UpdateRowSource UpdatedRowSource
    {
        get => inner.UpdatedRowSource;
        set => inner.UpdatedRowSource = value;
    }

    protected override DbConnection? DbConnection
    {
        get => _connection is not null ? _connection : inner.Connection;
        set
        {
            _connection = value as SendproofDbConnection;
            inner.Connection = _connection?.Inner ?? value;
        }
    }

    protected override DbParameterCollection DbParameterCollection => inner.Parameters;

    protected override DbTransaction? DbTransaction
    {
        get => _transaction;
        set
        {
            _transaction = value;
            inner.Transaction = SendproofDbConnection.Unwrap(value);
        }
    }

    public override void Cancel() => inner.Cancel();

    public override void Prepare() => inner.Prepare();

    public override Task PrepareAsync(CancellationToken cancellationToken = default) => inner.PrepareAsync(cancellationToken);

    protected override DbParameter CreateDbParameter() => inner.CreateParameter();

    private void Guard() => _connection?.Guard(this);

    private T Run<T>(Func<T> execute)
    {
        Guard();
        try
        {
            return execute();
        }
        catch (DbException error)
        {
            _connection?.Failed(error);
            throw;
        }
    }

    private async Task<T> RunAsync<T>(Func<Task<T>> execute)
    {
        Guard();
        try
        {
            return await execute();
        }
        catch (DbException error)
        {
            _connection?.Failed(error);
            throw;
        }
    }

    public override int ExecuteNonQuery() => Run(inner.ExecuteNonQuery);

    public override Task<int> ExecuteNonQueryAsync(CancellationToken cancellationToken) =>
        RunAsync(() => inner.ExecuteNonQueryAsync(cancellationToken));

    public override object? ExecuteScalar() => Run(inner.ExecuteScalar);

    public override Task<object?> ExecuteScalarAsync(CancellationToken cancellationToken) =>
        RunAsync(() => inner.ExecuteScalarAsync(cancellationToken));

    protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior) => Run(() => inner.ExecuteReader(behavior));

    protected override Task<DbDataReader> ExecuteDbDataReaderAsync(CommandBehavior behavior, CancellationToken cancellationToken) =>
        RunAsync(() => inner.ExecuteReaderAsync(behavior, cancellationToken));

    protected override void Dispose(bool disposing)
    {
        if (disposing) inner.Dispose();
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await inner.DisposeAsync();
        await base.DisposeAsync();
    }
}

/// <summary>
/// A transaction on a <see cref="SendproofDbConnection"/>. During a Preview its commit is refused, and so is a rollback
/// other than the Preview's own; savepoints work as the provider's, except the backstop's name.
/// </summary>
internal sealed class SendproofDbTransaction(SendproofDbConnection connection, DbTransaction inner) : DbTransaction
{
    internal DbTransaction Inner { get; } = inner;

    /// <summary>Whether the transaction has been committed, rolled back or disposed.</summary>
    internal bool Completed { get; private set; }

    public override IsolationLevel IsolationLevel => Inner.IsolationLevel;

    protected override DbConnection DbConnection => connection;

    public override bool SupportsSavepoints => Inner.SupportsSavepoints;

    public override void Commit()
    {
        connection.Refuse("a commit of its transaction");
        Inner.Commit();
        Completed = true;
    }

    public override async Task CommitAsync(CancellationToken cancellationToken = default)
    {
        connection.Refuse("a commit of its transaction");
        await Inner.CommitAsync(cancellationToken);
        Completed = true;
    }

    public override void Rollback()
    {
        if (!OwnSql.IsActive) connection.Refuse("a rollback of its transaction");
        Inner.Rollback();
        Completed = true;
    }

    public override async Task RollbackAsync(CancellationToken cancellationToken = default)
    {
        if (!OwnSql.IsActive) connection.Refuse("a rollback of its transaction");
        await Inner.RollbackAsync(cancellationToken);
        Completed = true;
    }

    public override void Save(string savepointName)
    {
        connection.GuardSavepoint(savepointName);
        Inner.Save(savepointName);
    }

    public override Task SaveAsync(string savepointName, CancellationToken cancellationToken = default)
    {
        connection.GuardSavepoint(savepointName);
        return Inner.SaveAsync(savepointName, cancellationToken);
    }

    public override void Rollback(string savepointName)
    {
        connection.GuardSavepoint(savepointName);
        Inner.Rollback(savepointName);
    }

    public override Task RollbackAsync(string savepointName, CancellationToken cancellationToken = default)
    {
        connection.GuardSavepoint(savepointName);
        return Inner.RollbackAsync(savepointName, cancellationToken);
    }

    public override void Release(string savepointName)
    {
        connection.GuardSavepoint(savepointName);
        Inner.Release(savepointName);
    }

    public override Task ReleaseAsync(string savepointName, CancellationToken cancellationToken = default)
    {
        connection.GuardSavepoint(savepointName);
        return Inner.ReleaseAsync(savepointName, cancellationToken);
    }

    // Disposing an open transaction rolls it back, after which a save would commit on its own: only the Preview's own
    // cleanup may do that while a Preview runs.
    private void GuardDispose()
    {
        if (!Completed && !OwnSql.IsActive) connection.Refuse("disposing its transaction");
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            GuardDispose();
            Completed = true;
            Inner.Dispose();
        }

        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        GuardDispose();
        Completed = true;
        await Inner.DisposeAsync();
        await base.DisposeAsync();
    }
}
