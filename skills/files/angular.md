# Angular Testing Reference

## Setup

Angular CLI projects come with Karma + Jasmine by default. For new projects, consider
migrating to Jest (via `@angular-builders/jest`) or Vitest (via `@analogjs/vitest-angular`).

## TestBed — the Core of Angular Testing

TestBed creates a testing module that mimics an Angular `@NgModule`. Use it for
components, services, pipes, and directives.

### Component Test

```typescript
import { ComponentFixture, TestBed } from '@angular/core/testing'
import { UserCardComponent } from './user-card.component'

describe('UserCardComponent', () => {
  let component: UserCardComponent
  let fixture: ComponentFixture<UserCardComponent>

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UserCardComponent] // standalone component
    }).compileComponents()

    fixture = TestBed.createComponent(UserCardComponent)
    component = fixture.componentInstance
  })

  it('should create', () => {
    expect(component).toBeTruthy()
  })

  it('displays user name', () => {
    component.user = { id: 1, name: 'Alice', email: 'a@b.com' }
    fixture.detectChanges()

    const el: HTMLElement = fixture.nativeElement
    expect(el.querySelector('[data-testid="user-name"]')?.textContent).toContain('Alice')
  })

  it('emits delete event on button click', () => {
    component.user = { id: 1, name: 'Alice', email: 'a@b.com' }
    fixture.detectChanges()

    spyOn(component.deleted, 'emit')
    const btn = fixture.nativeElement.querySelector('[data-testid="delete-btn"]')
    btn.click()

    expect(component.deleted.emit).toHaveBeenCalledWith(1)
  })
})
```

### Service Test

```typescript
import { TestBed } from '@angular/core/testing'
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing'
import { UserService } from './user.service'

describe('UserService', () => {
  let service: UserService
  let httpMock: HttpTestingController

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [UserService]
    })
    service = TestBed.inject(UserService)
    httpMock = TestBed.inject(HttpTestingController)
  })

  afterEach(() => httpMock.verify()) // no outstanding requests

  it('fetches users', () => {
    const mockUsers = [{ id: 1, name: 'Alice' }]

    service.getUsers().subscribe((users) => {
      expect(users).toEqual(mockUsers)
    })

    const req = httpMock.expectOne('/api/users')
    expect(req.request.method).toBe('GET')
    req.flush(mockUsers)
  })

  it('handles 404', () => {
    service.getUser(999).subscribe({
      error: (err) => expect(err.status).toBe(404)
    })

    const req = httpMock.expectOne('/api/users/999')
    req.flush('Not Found', { status: 404, statusText: 'Not Found' })
  })
})
```

### Pipe Test

```typescript
import { TruncatePipe } from './truncate.pipe'

describe('TruncatePipe', () => {
  const pipe = new TruncatePipe()

  it('truncates long strings', () => {
    expect(pipe.transform('Hello World', 5)).toBe('Hello...')
  })

  it('returns short strings unchanged', () => {
    expect(pipe.transform('Hi', 10)).toBe('Hi')
  })

  it('handles null', () => {
    expect(pipe.transform(null, 5)).toBe('')
  })
})
```

### Directive Test

```typescript
import { Component } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { HighlightDirective } from './highlight.directive'

@Component({
  template: `<p appHighlight="yellow">Test</p>`,
  imports: [HighlightDirective],
  standalone: true
})
class TestHostComponent {}

describe('HighlightDirective', () => {
  it('sets background color', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [TestHostComponent]
    }).createComponent(TestHostComponent)

    fixture.detectChanges()
    const p: HTMLElement = fixture.nativeElement.querySelector('p')
    expect(p.style.backgroundColor).toBe('yellow')
  })
})
```

### Mocking Dependencies

```typescript
// Provide a mock service
const mockAuthService = jasmine.createSpyObj('AuthService', ['isLoggedIn', 'getUser'])
mockAuthService.isLoggedIn.and.returnValue(true)

await TestBed.configureTestingModule({
  imports: [DashboardComponent],
  providers: [{ provide: AuthService, useValue: mockAuthService }]
}).compileComponents()
```

### Testing Observables (RxJS)

```typescript
import { of, throwError } from 'rxjs'

it('handles stream values', (done) => {
  service.getData().subscribe({
    next: (data) => {
      expect(data.length).toBeGreaterThan(0)
      done()
    },
    error: done.fail
  })
})
```

### Router Testing

```typescript
import { RouterTestingModule } from '@angular/router/testing'
import { Router } from '@angular/router'

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [
      RouterTestingModule.withRoutes([{ path: 'dashboard', component: DashboardComponent }])
    ]
  })
})

it('navigates to dashboard', () => {
  const router = TestBed.inject(Router)
  const spy = spyOn(router, 'navigate')
  component.goToDashboard()
  expect(spy).toHaveBeenCalledWith(['/dashboard'])
})
```

## Running

```bash
ng test                       # Karma (default)
ng test --watch=false         # single run (CI)
ng test --code-coverage       # with coverage
npx jest                      # if using Jest builder
```

## Key Principles for Angular Tests

1. **Use `fixture.detectChanges()`** after setting inputs — Angular doesn't auto-detect in tests.
2. **Prefer standalone components** — simpler TestBed setup, no module imports.
3. **Mock HTTP with `HttpTestingController`** — verify request methods, URLs, and bodies.
4. **Call `httpMock.verify()` in afterEach** — catches unexpected HTTP calls.
5. **Test the template, not just the class** — use `fixture.nativeElement` to verify rendering.
