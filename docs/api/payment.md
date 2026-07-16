# Payment API

All payment routes are prefixed with `/api/v1/payment` and require an
authenticated Clerk session, except for Paddle webhook routes.

## Create an overlay checkout transaction

`POST /api/v1/payment/checkout`

Creates a Paddle transaction for an active tier price. The server derives the
user ID and name from the authenticated user; clients must not send identity
data.

Request:

```json
{
  "priceId": "pri_01gm81eqze2vmmvhpjg13bfeqg"
}
```

Response:

```json
{
  "transactionId": "txn_01h0j589qt1nee24210teqtz57",
  "tier": {
    "id": "6651f2c21f2db72ae60ac123",
    "name": "Pro"
  },
  "billingInterval": "monthly"
}
```

Open the Paddle overlay on the frontend using the returned transaction ID:

```ts
Paddle.Checkout.open({ transactionId: response.transactionId });
```

The server stores the authenticated user's ID and name as transaction custom
data so webhook processing can safely associate the resulting subscription with
the user.
