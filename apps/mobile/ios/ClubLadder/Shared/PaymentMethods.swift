import Foundation

// Port of isReservedMethod in packages/shared/src/utils/payment-methods.ts, via
// PaymentMethods.kt. Keep in step with it. A waived fee is a paid row with
// method 'waived'.

let reservedMethod = "waived"

func isReservedMethod(_ value: String?) -> Bool {
    guard let value else { return false }
    return value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == reservedMethod
}
