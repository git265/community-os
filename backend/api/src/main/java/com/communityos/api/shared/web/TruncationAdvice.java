package com.communityos.api.shared.web;

import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyAdvice;

/** Adds `X-List-Truncated` to a response whose list reached its cap (see Truncation). */
@RestControllerAdvice
public class TruncationAdvice implements ResponseBodyAdvice<Object> {
    @Override public boolean supports(MethodParameter returnType, Class<? extends HttpMessageConverter<?>> converterType) { return true; }
    @Override public Object beforeBodyWrite(Object body, MethodParameter returnType, MediaType contentType, Class<? extends HttpMessageConverter<?>> converterType,
                                            ServerHttpRequest request, ServerHttpResponse response) {
        int cap = Truncation.reached();
        if (cap > 0) response.getHeaders().set(Truncation.HEADER, String.valueOf(cap));
        return body;
    }
}
