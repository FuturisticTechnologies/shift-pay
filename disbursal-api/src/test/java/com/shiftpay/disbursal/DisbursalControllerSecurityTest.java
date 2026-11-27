package com.shiftpay.disbursal;

import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.nimbusds.jose.jwk.source.ImmutableSecret;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(DisbursalController.class)
@Import(SecurityConfig.class)
@TestPropertySource(properties = "app.security.jwt.secret=test-secret-test-secret-test-secret-1234")
class DisbursalControllerSecurityTest {

    private static final String SECRET = "test-secret-test-secret-test-secret-1234";
    private static final String URL = "/api/v1/disbursals";
    private static final String BODY = "{\"employeeId\":\"E1\",\"amount\":100}";

    @Autowired MockMvc mockMvc;
    @MockBean DisbursalService disbursalService;

    @Test
    void missingToken_returns401_andServiceNotCalled() throws Exception {
        mockMvc.perform(post(URL).contentType(APPLICATION_JSON).content(BODY))
            .andExpect(status().isUnauthorized());
        verifyNoInteractions(disbursalService);
    }

    @Test
    void expiredToken_returns401_andServiceNotCalled() throws Exception {
        String token = token(Instant.now().minus(2, ChronoUnit.HOURS));
        mockMvc.perform(post(URL).header("Authorization", "Bearer " + token)
                .contentType(APPLICATION_JSON).content(BODY))
            .andExpect(status().isUnauthorized());
        verifyNoInteractions(disbursalService);
    }

    @Test
    void validToken_passesThrough() throws Exception {
        String token = token(Instant.now().plus(1, ChronoUnit.HOURS));
        mockMvc.perform(post(URL).header("Authorization", "Bearer " + token)
                .contentType(APPLICATION_JSON).content(BODY))
            .andExpect(status().isAccepted());
    }

    private String token(Instant expiresAt) {
        SecretKey key = new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        JwtEncoder encoder = new NimbusJwtEncoder(new ImmutableSecret<>(key));
        JwtClaimsSet claims = JwtClaimsSet.builder()
            .subject("test-user")
            .issuedAt(expiresAt.minus(2, ChronoUnit.HOURS))
            .expiresAt(expiresAt)
            .build();
        return encoder.encode(JwtEncoderParameters.from(
            JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
    }
}
