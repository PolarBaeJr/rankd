package com.clubladder.app.shared

// Port of isReservedMethod in packages/shared/src/utils/payment-methods.ts.
// Keep in step with it. A waived fee is a paid row with method 'waived'.

const val RESERVED_METHOD = "waived"

fun isReservedMethod(value: String?): Boolean = value != null && value.trim().lowercase() == RESERVED_METHOD
