package com.shiftpay.disbursal;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/disbursals")
public class DisbursalController {

    private final DisbursalService service;

    public DisbursalController(DisbursalService service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<Void> create(@RequestBody Map<String, Object> request) {
        service.process(request);
        return ResponseEntity.accepted().build();
    }
}
