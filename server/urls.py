from django.urls import path
from cinema import views
urlpatterns = [
    path('',views.asset),
    path('api/session',views.session),
    path('api/auth/email/start',views.email_start),
    path('api/auth/password/login',views.password_login),
    path('api/auth/password/set',views.password_set),
    path('api/auth/email/verify',views.email_verify),
    path('api/auth/register/verify',views.register_verify),
    path('api/auth/yandex/start',views.yandex_start),
    path('api/auth/yandex/callback',views.yandex_callback),
    path('api/account/merge/preview',views.merge_preview),
    path('api/account/merge/confirm',views.merge_confirm),
    path('api/auth/logout',views.sign_out),
    path('api/auth/logout-all',views.sign_out_all),
    path('api/account/delete',views.delete_account),
    path('api/archive',views.archive),
    path('api/catalog',views.catalog),
    path('<str:name>',views.asset),
]
