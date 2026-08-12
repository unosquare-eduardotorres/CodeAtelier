# Stub Detection Reference

## What Counts as a Stub

A stub is code that exists to satisfy an interface but provides no real functionality.
Stubs are the #1 cause of "it builds but doesn't work" failures.

## Stub Categories

### 1. Empty Returns

```typescript
// STUB — returns nothing useful
function getUser(id: string): User | null {
  return null
}

// STUB — returns empty collection
function getProducts(): Product[] {
  return []
}

// STUB — returns empty object
function getConfig(): Config {
  return {} as Config
}
```

### 2. Hardcoded Data

```typescript
// STUB — always returns same data regardless of input
function getUser(id: string): User {
  return { id: '1', name: 'John', email: 'john@example.com' }
}

// STUB — static array pretending to be a database
const products = [
  { id: 1, name: 'Widget', price: 9.99 },
  { id: 2, name: 'Gadget', price: 19.99 }
]
```

### 3. Console-Only Logic

```typescript
// STUB — logs instead of doing real work
function saveOrder(order: Order): void {
  console.log('Saving order:', order)
}

// STUB — alerts instead of real error handling
function handleError(error: Error): void {
  console.error('Error:', error.message)
}
```

### 4. Commented-Out Implementation

```typescript
function processPayment(amount: number): PaymentResult {
  // TODO: Implement Stripe integration
  // const stripe = new Stripe(process.env.STRIPE_KEY)
  // return stripe.charges.create({ amount })
  return { success: true, transactionId: 'mock-123' }
}
```

### 5. UI Stubs

```tsx
// STUB — renders nothing meaningful
function UserProfile() {
  return <div>User Profile</div>
}

// STUB — placeholder instead of real component
function Dashboard() {
  return (
    <div>
      <p>Dashboard coming soon</p>
    </div>
  )
}

// STUB — component with no data binding
function ProductList() {
  return (
    <ul>
      <li>Product 1</li>
      <li>Product 2</li>
    </ul>
  )
}
```

### 6. Partial Implementation

```typescript
// STUB — handles happy path only
async function createUser(data: CreateUserInput): Promise<User> {
  // No validation
  // No duplicate check
  // No error handling
  const user = await db.insert('users', data)
  return user
}
```

## Detection Regex Patterns

```regex
# Empty returns
return\s+(null|undefined|\{\}|\[\]|''|""|0|false)\s*;?$

# TODO/placeholder markers
(TODO|FIXME|HACK|XXX|PLACEHOLDER|COMING SOON|NOT IMPLEMENTED)

# Console-only handlers
^\s*(console\.(log|error|warn)|alert)\(.*\)\s*;?\s*$

# Empty arrow functions
=>\s*\{\s*\}

# Mock/fake identifiers
(mock|fake|dummy|placeholder|stub|sample|example|test)\w*\s*[:=]

# Hardcoded IDs/values in non-test files
['"][\w-]+(mock|test|fake|sample|example)[\w-]*['"]
```

## When Stubs Are Acceptable

1. **Type definitions** — Types don't need implementation
2. **Interface declarations** — Interfaces are contracts, not stubs
3. **Test fixtures** — Mock data in test files is expected
4. **Explicitly deferred** — `// STUB: <reason> — task T0XX` with a clear plan
5. **Configuration defaults** — Empty config objects that get populated at runtime
