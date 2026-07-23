---
title: "Turning an N+1 Query into a Single Query"
description: "A real-world reflection on identifying the N+1 query pattern in a payment history endpoint and how restructuring data access fixed a major performance bottleneck."
date: "2026-03-13"
language: "en"
author: "Trung-Nghia Nguyen"
tags: ["blog", "backend", "dotnet", "performance", "database"]
featured: false
---

![N+1 Problem example](https://lh3.googleusercontent.com/d/1Yo9QPvBl0zKv0TWgwGeirRnyr4nW680W=s2200?authuser=0)

## The N+1 Query Pattern

One of the most common performance issues in backend development is the N+1 query problem. It usually occurs when we fetch a list of records first, then query related data inside a loop. The code works, the API returns the correct data, but the database is hammered with unnecessary requests.

If the result contains N records, the system performs:

- 1 query for the main dataset  
- N additional queries for related data  
- Total: N + 1 queries

This pattern is a silent performance killer. It feels fast with 5 records in development but crawls once a user has hundreds of records in production.

## A Real Case: Payment History API

I recently worked on an endpoint to retrieve a user's payment history:

`GET /api/payments/history`

Each record required basic payment info plus the name of the related product or subscription. My first implementation (the "naive" approach) looked like this:

```csharp
var payments = await _dbContext.Payments
    .Where(p => p.UserId == userId)
    .OrderByDescending(p => p.CreatedAt)
    .ToListAsync();

var result = new List<PaymentHistoryItem>();

foreach (var payment in payments)
{
    // The N+1 Trigger: Querying inside the loop
    var subscription = await _dbContext.Subscriptions
        .FirstOrDefaultAsync(s => s.Id == payment.SubscriptionId);

    result.Add(new PaymentHistoryItem
    {
        PaymentId = payment.Id,
        Amount = payment.Amount,
        Status = payment.Status,
        ProductName = subscription?.ProductName
    });
}
```

If a user had 120 payments, this triggered 121 database round-trips. This wasn't just slow; it was dangerous for scalability and increased the risk of database connection pool exhaustion.

## The Optimization

The fix was to move the relationship resolution from the application loop into the database layer using projection. This allows the ORM to generate a single SQL JOIN.

```csharp
var result = await _dbContext.Payments
    .Where(p => p.UserId == userId)
    .OrderByDescending(p => p.CreatedAt)
    .Select(p => new PaymentHistoryItem
    {
        PaymentId = p.Id,
        Amount = p.Amount,
        Status = p.Status,
        // The ORM handles the join here
        ProductName = p.Subscription.ProductName
    })
    .ToListAsync();
```

Now, regardless of whether the user has 10 or 1,000 payments, the endpoint performs exactly one database query.

## Lessons Learned

Although the code here is written with C# and Entity Framework, the underlying lesson applies to **any** backend stack, ORM, or query builder.

The key takeaway is a simple rule for any backend developer: **never execute database queries inside a loop**.

- **Think in Sets**: Databases are optimized to handle relationships. Let them do the heavy lifting using joins, `IN` queries, or bulk fetches instead of per-item lookups.
- **Use Projections / Selects**: Whether it's `.Select`, `SELECT column1, column2`, or a typed DTO, only fetch the specific columns you need.
- **Watch for Implicit Lazy Loading**: Many ORMs in many languages can hide N+1 patterns behind property access or relationship navigation.
- **Audit Your Logs**: Periodically check your SQL or query logs. If you see the same query repeating with different IDs, you have an N+1 problem—no matter which language or framework you use.

## Final Thought

The N+1 problem rarely looks like a bug—it looks like clean, readable code. But as a developer, your job is to think about how that code behaves when \(N\) grows. Turning N+1 into a single query is a small change that makes the difference between a struggling API and a high-performance system.

