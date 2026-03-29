# Java Testing Reference

## Framework: JUnit 5 + Mockito + Spring Boot Test

### Setup (Maven)
```xml
<dependencies>
  <dependency>
    <groupId>org.junit.jupiter</groupId>
    <artifactId>junit-jupiter</artifactId>
    <scope>test</scope>
  </dependency>
  <dependency>
    <groupId>org.mockito</groupId>
    <artifactId>mockito-junit-jupiter</artifactId>
    <scope>test</scope>
  </dependency>
  <dependency>
    <groupId>org.assertj</groupId>
    <artifactId>assertj-core</artifactId>
    <scope>test</scope>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-test</artifactId>
    <scope>test</scope>
  </dependency>
  <dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>junit-jupiter</artifactId>
    <scope>test</scope>
  </dependency>
</dependencies>
```

## Unit Tests

### Basic JUnit 5
```java
import static org.assertj.core.api.Assertions.*;

class DiscountCalculatorTest {

    private final DiscountCalculator calculator = new DiscountCalculator();

    @Test
    void calculate_appliesPercentageDiscount() {
        assertThat(calculator.calculate(100.0, 10)).isEqualTo(90.0);
    }

    @Test
    void calculate_withNegativePrice_throwsException() {
        assertThatThrownBy(() -> calculator.calculate(-10.0, 5))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("non-negative");
    }

    @ParameterizedTest
    @CsvSource({"100,0,100", "100,50,50", "100,100,0", "0,50,0"})
    void calculate_boundaryValues(double price, int pct, double expected) {
        assertThat(calculator.calculate(price, pct)).isEqualTo(expected);
    }
}
```

### Mockito
```java
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {

    @Mock private OrderRepository repository;
    @Mock private EmailSender emailSender;
    @InjectMocks private OrderService service;

    @Test
    void placeOrder_sendsConfirmationEmail() {
        when(repository.save(any(Order.class)))
            .thenReturn(new Order(1L, "Widget"));

        service.placeOrder(new OrderRequest("Widget"));

        verify(emailSender).send(
            contains("@"),
            contains("Widget")
        );
    }

    @Test
    void placeOrder_whenRepoFails_throwsServiceException() {
        when(repository.save(any()))
            .thenThrow(new DataAccessException("Connection lost") {});

        assertThatThrownBy(() -> service.placeOrder(new OrderRequest("Widget")))
            .isInstanceOf(ServiceException.class);
    }
}
```

## Integration Tests: Spring Boot

### MockMvc (no server started)
```java
@WebMvcTest(ItemController.class)
class ItemControllerTest {

    @Autowired private MockMvc mockMvc;
    @MockBean private ItemService itemService;

    @Test
    void getItem_returnsItem() throws Exception {
        when(itemService.findById(1L))
            .thenReturn(Optional.of(new Item(1L, "Widget", 9.99)));

        mockMvc.perform(get("/api/items/1"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.name").value("Widget"));
    }

    @Test
    void getItem_notFound_returns404() throws Exception {
        when(itemService.findById(999L)).thenReturn(Optional.empty());

        mockMvc.perform(get("/api/items/999"))
            .andExpect(status().isNotFound());
    }

    @Test
    void createItem_returns201() throws Exception {
        when(itemService.create(any()))
            .thenReturn(new Item(1L, "Widget", 9.99));

        mockMvc.perform(post("/api/items")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""
                    {"name": "Widget", "price": 9.99}
                    """))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.id").exists());
    }
}
```

### Full Integration (@SpringBootTest)
```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
class ItemApiIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired private TestRestTemplate restTemplate;

    @Test
    void fullCrudFlow() {
        // Create
        var createRes = restTemplate.postForEntity("/api/items",
            new ItemRequest("Widget", 9.99), ItemResponse.class);
        assertThat(createRes.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        Long id = createRes.getBody().getId();

        // Read
        var getRes = restTemplate.getForEntity("/api/items/" + id, ItemResponse.class);
        assertThat(getRes.getBody().getName()).isEqualTo("Widget");

        // Delete
        restTemplate.delete("/api/items/" + id);
        var after = restTemplate.getForEntity("/api/items/" + id, String.class);
        assertThat(after.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }
}
```

### Repository Test (JPA)
```java
@DataJpaTest
class UserRepositoryTest {

    @Autowired private UserRepository repo;
    @Autowired private TestEntityManager em;

    @Test
    void findByEmail_returnsMatchingUser() {
        em.persistAndFlush(new User("Alice", "alice@test.com"));

        var user = repo.findByEmail("alice@test.com");

        assertThat(user).isPresent();
        assertThat(user.get().getName()).isEqualTo("Alice");
    }
}
```

## Running
```bash
mvn test                            # all tests
mvn test -Dtest=ItemControllerTest  # specific class
mvn verify                          # includes integration tests
mvn test -Dgroups=unit              # JUnit 5 tags
./gradlew test                      # Gradle
```

## Key Principles for Java Tests
1. **Use `@ExtendWith(MockitoExtension.class)`** — cleaner than `MockitoAnnotations.openMocks`.
2. **Prefer AssertJ** — `assertThat(x).isEqualTo(y)` is more readable and has better error messages.
3. **Use `@WebMvcTest` for controller unit tests** — faster than `@SpringBootTest`.
4. **Use Testcontainers for DB integration** — real database, reproducible, CI-friendly.
5. **Slice tests** — `@DataJpaTest`, `@WebMvcTest`, `@JsonTest` load only what's needed.
