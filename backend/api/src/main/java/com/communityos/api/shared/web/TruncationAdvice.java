package com.communityos.api.shared.web;

import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyAdvice;

/**
 * Just before a response body is written: adds `X-List-Truncated` when a list reached its cap (Truncation), and gives a read request's shared
 * database connection back to the pool (TenantDataSource), so it is not held while a slow client downloads the answer.
 */
@RestControllerAdvice
public class TruncationAdvice implements ResponseBodyAdvice<Object> {
    @Override public boolean supports(MethodParameter returnType, Class<? extends HttpMessageConverter<?>> converterType) { return true; }
    @Override public Object beforeBodyWrite(Object body, MethodParameter returnType, MediaType contentType, Class<? extends HttpMessageConverter<?>> converterType,
                                            ServerHttpRequest request, ServerHttpResponse response) {
        int cap = Truncation.reached();
        if (cap > 0) response.getHeaders().set(Truncation.HEADER, String.valueOf(cap));
        com.communityos.api.shared.tenancy.TenantDataSource.release();   // anything read after this takes a connection per statement again
        return body;
    }
}
