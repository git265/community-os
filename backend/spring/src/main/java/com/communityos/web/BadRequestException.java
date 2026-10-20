package com.communityos.web;

public class BadRequestException extends RuntimeException {
    public BadRequestException(String message) { super(message); }
}
